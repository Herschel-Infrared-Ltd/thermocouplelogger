import mqtt, { type MqttClient } from "mqtt";
import pc from "picocolors";
import type { ThingsBoardConfig } from "./config";

export interface TbSinkOptions {
  host: string;
  port: number;
  token: string;
  /** If true, log payloads instead of publishing. */
  dryRun: boolean;
  /** TB device profile for auto-created channel devices. */
  deviceProfile: string;
  /** Batch flush interval in ms. */
  flushIntervalMs: number;
  /**
   * Exit the process (for systemd to restart) after this long without a
   * connection. 0 disables. Default 15 minutes.
   */
  offlineExitMs?: number;
  /** Max buffered readings retained per device while offline. Default 300. */
  offlineBufferPerDevice?: number;
  /** Watchdog tick interval in ms. Default 30s. Exposed for tests. */
  watchdogIntervalMs?: number;
  /** No-puback-while-connected stall threshold in ms. Default 3 minutes. */
  stallMs?: number;
}

interface ChannelReading {
  ts: number;
  values: Record<string, number | string | boolean>;
}

export interface TbSink {
  /** Announce a per-channel device + publish its static attributes. Idempotent. */
  ensureDevice(deviceName: string, attrs: Record<string, unknown>): void;
  /** Enqueue a telemetry reading for the next batch flush. */
  enqueueTelemetry(deviceName: string, reading: ChannelReading): void;
  /** Force-flush the current batch (for shutdown). */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Max readings sent in a single gateway telemetry publish. */
const MAX_READINGS_PER_PUBLISH = 500;
/** Minimum gap between repeated error/close/reconnect log lines. */
const LOG_THROTTLE_MS = 5 * 60_000;

export function createTbSink(opts: TbSinkOptions): TbSink {
  const connected = new Set<string>();
  const buffer = new Map<string, ChannelReading[]>();
  let client: MqttClient | null = null;

  const url = `mqtt://${opts.host}:${opts.port}`;
  const offlineExitMs = opts.offlineExitMs ?? 15 * 60_000;
  const offlineBufferPerDevice = opts.offlineBufferPerDevice ?? 300;
  const watchdogIntervalMs = opts.watchdogIntervalMs ?? 30_000;
  const stallMs = opts.stallMs ?? 3 * 60_000;

  // Health state
  let connectedNow = false;
  let lastConnectedAt: number | null = null;
  let lastPubAttemptAt: number | null = null;
  let lastPubAckAt: number | null = null;
  let startedAt = Date.now();
  let forcedReconnects = 0;
  let announcedOffline = false;
  let closing = false;

  // Throttled logging: key -> {last, suppressed}
  const logState = new Map<string, { last: number; suppressed: number }>();
  function throttledLog(key: string, message: string, level: "warn" | "error" = "warn") {
    const now = Date.now();
    const st = logState.get(key);
    const emit = (text: string) => {
      if (level === "error") console.error(pc.red(text));
      else console.log(pc.yellow(text));
    };
    if (!st) {
      logState.set(key, { last: now, suppressed: 0 });
      emit(message);
      return;
    }
    if (now - st.last >= LOG_THROTTLE_MS) {
      const suffix = st.suppressed > 0 ? ` (x${st.suppressed + 1} in last 5m)` : "";
      st.last = now;
      st.suppressed = 0;
      emit(`${message}${suffix}`);
      return;
    }
    st.suppressed += 1;
  }

  function attach(c: MqttClient): void {
    c.on("connect", () => {
      connectedNow = true;
      lastConnectedAt = Date.now();
      logState.clear();
      console.log(pc.green(`[tb] connected to ${url}`));
      if (announcedOffline) {
        let pending = 0;
        for (const readings of buffer.values()) pending += readings.length;
        console.log(pc.green(`[tb] reconnected, flushing ${pending} buffered readings`));
        announcedOffline = false;
      }
    });
    c.on("error", (err) => {
      throttledLog("error", `[tb] error: ${err.message}`, "error");
    });
    c.on("reconnect", () => {
      throttledLog("reconnect", `[tb] reconnecting...`);
    });
    c.on("offline", () => {
      connectedNow = false;
    });
    c.on("close", () => {
      connectedNow = false;
      throttledLog("close", `[tb] connection closed`);
    });
  }

  function connect(): void {
    client = mqtt.connect(url, {
      username: opts.token,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      keepalive: 30,
      clean: true,
    });
    attach(client);
  }

  if (!opts.dryRun) {
    connect();
  } else {
    console.log(pc.yellow(`[tb] dry-run: payloads will be logged, not published`));
  }

  function publish(topic: string, payload: unknown): void {
    const body = JSON.stringify(payload);
    if (opts.dryRun || !client) {
      console.log(pc.cyan(`[tb dry-run] ${topic} ${body}`));
      return;
    }
    lastPubAttemptAt = Date.now();
    client.publish(topic, body, { qos: 1 }, (err) => {
      if (err) {
        console.error(pc.red(`[tb] publish ${topic} failed: ${err.message}`));
        return;
      }
      lastPubAckAt = Date.now();
      // A real ack means the link works; clear the forced-reconnect streak.
      forcedReconnects = 0;
    });
  }

  /** Trim each device's buffer to the offline cap, dropping oldest. */
  function capBuffer(): void {
    for (const [device, readings] of buffer) {
      if (readings.length > offlineBufferPerDevice) {
        buffer.set(device, readings.slice(readings.length - offlineBufferPerDevice));
      }
    }
  }

  const sink: TbSink = {
    ensureDevice(deviceName, attrs) {
      if (connected.has(deviceName)) return;
      connected.add(deviceName);
      publish("v1/gateway/connect", { device: deviceName, type: opts.deviceProfile });
      if (attrs && Object.keys(attrs).length > 0) {
        publish("v1/gateway/attributes", { [deviceName]: attrs });
      }
    },

    enqueueTelemetry(deviceName, reading) {
      if (!buffer.has(deviceName)) buffer.set(deviceName, []);
      buffer.get(deviceName)!.push(reading);
    },

    async flush() {
      if (buffer.size === 0) return;

      // Offline: hold readings in our own bounded buffer rather than letting
      // mqtt.js queue them without limit.
      if (!opts.dryRun && !connectedNow) {
        capBuffer();
        if (!announcedOffline) {
          announcedOffline = true;
          console.log(
            pc.yellow(`[tb] offline, buffering (max ${offlineBufferPerDevice}/device)`),
          );
        }
        return;
      }

      // Drain in chunks so a long offline backlog doesn't exceed TB payload limits.
      let payload: Record<string, ChannelReading[]> = {};
      let count = 0;
      const send = () => {
        if (count > 0) publish("v1/gateway/telemetry", payload);
        payload = {};
        count = 0;
      };
      for (const [device, readings] of buffer) {
        for (const reading of readings) {
          if (!payload[device]) payload[device] = [];
          payload[device]!.push(reading);
          count += 1;
          if (count >= MAX_READINGS_PER_PUBLISH) send();
        }
      }
      send();
      buffer.clear();
    },

    async close() {
      closing = true;
      clearInterval(watchdog);
      await sink.flush();
      if (client) {
        await new Promise<void>((resolve) => client!.end(false, {}, () => resolve()));
      }
    },
  };

  function forceReconnect(reason: string): void {
    forcedReconnects += 1;
    console.log(pc.yellow(`[tb] watchdog: ${reason}, forcing reconnect`));
    const old = client;
    client = null;
    connectedNow = false;
    try {
      old?.end(true);
    } catch {
      /* ignore */
    }
    connect();
  }

  const watchdog = setInterval(() => {
    if (opts.dryRun || closing) return;
    const now = Date.now();

    if (connectedNow) {
      const attemptedRecently = lastPubAttemptAt !== null && now - lastPubAttemptAt <= stallMs;
      const ackedRecently = lastPubAckAt !== null && now - lastPubAckAt <= stallMs;
      if (attemptedRecently && !ackedRecently) {
        if (forcedReconnects >= 3) {
          console.error(
            pc.red(`[tb] watchdog: giving up, exiting for systemd restart`),
          );
          process.exit(1);
        }
        const since = lastPubAckAt === null ? now - startedAt : now - lastPubAckAt;
        forceReconnect(`link stalled (no puback for ${Math.round(since / 1000)}s)`);
      }
      return;
    }

    if (offlineExitMs > 0) {
      const offlineSince = lastConnectedAt ?? startedAt;
      if (now - offlineSince >= offlineExitMs) {
        console.error(
          pc.red(
            `[tb] watchdog: offline for ${Math.round((now - offlineSince) / 1000)}s, exiting for systemd restart`,
          ),
        );
        process.exit(1);
      }
    }
  }, watchdogIntervalMs);
  watchdog.unref?.();

  const timer = setInterval(() => {
    sink.flush().catch((err) =>
      console.error(pc.red(`[tb] flush error: ${err.message}`)),
    );
  }, opts.flushIntervalMs);
  timer.unref?.();

  return sink;
}

/**
 * Build a sink from the config.json thingsboard block.
 * Returns null when not enabled. Honors TB_DRY_RUN=true env var as a kill-switch.
 */
export function tbSinkFromConfig(tb?: ThingsBoardConfig): TbSink | null {
  if (!tb || !tb.enabled) return null;
  if (!tb.accessToken) {
    console.error(pc.red("[tb] enabled=true but no accessToken in config; sink disabled"));
    return null;
  }
  const host = tb.host || "iot.hi-infrastructure.net";
  const port = tb.port ?? 1883;
  const deviceProfile = tb.deviceProfile || "Thermocouple";
  const flushIntervalMs = tb.flushIntervalMs ?? 2000;
  const offlineExitMinutes = tb.offlineExitMinutes ?? 15;
  const offlineBufferPerDevice = tb.offlineBufferPerDevice ?? 300;
  const dryRun = process.env.TB_DRY_RUN === "true";
  return createTbSink({
    host,
    port,
    token: tb.accessToken,
    deviceProfile,
    flushIntervalMs,
    offlineExitMs: Math.round(offlineExitMinutes * 60_000),
    offlineBufferPerDevice,
    dryRun,
  });
}
