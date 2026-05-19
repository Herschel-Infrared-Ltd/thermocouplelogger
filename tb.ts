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

export function createTbSink(opts: TbSinkOptions): TbSink {
  const connected = new Set<string>();
  const buffer = new Map<string, ChannelReading[]>();
  let client: MqttClient | null = null;

  if (!opts.dryRun) {
    const url = `mqtt://${opts.host}:${opts.port}`;
    client = mqtt.connect(url, {
      username: opts.token,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      clean: true,
    });
    client.on("connect", () => {
      console.log(pc.green(`[tb] connected to ${url}`));
    });
    client.on("error", (err) => {
      console.error(pc.red(`[tb] error: ${err.message}`));
    });
    client.on("reconnect", () => {
      console.log(pc.yellow(`[tb] reconnecting...`));
    });
    client.on("close", () => {
      console.log(pc.yellow(`[tb] connection closed`));
    });
  } else {
    console.log(pc.yellow(`[tb] dry-run: payloads will be logged, not published`));
  }

  function publish(topic: string, payload: unknown): void {
    const body = JSON.stringify(payload);
    if (opts.dryRun || !client) {
      console.log(pc.cyan(`[tb dry-run] ${topic} ${body}`));
      return;
    }
    client.publish(topic, body, { qos: 1 }, (err) => {
      if (err) console.error(pc.red(`[tb] publish ${topic} failed: ${err.message}`));
    });
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
      const payload: Record<string, ChannelReading[]> = {};
      for (const [device, readings] of buffer) {
        if (readings.length > 0) payload[device] = readings;
      }
      buffer.clear();
      if (Object.keys(payload).length > 0) {
        publish("v1/gateway/telemetry", payload);
      }
    },

    async close() {
      await sink.flush();
      if (client) {
        await new Promise<void>((resolve) => client!.end(false, {}, () => resolve()));
      }
    },
  };

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
  const dryRun = process.env.TB_DRY_RUN === "true";
  return createTbSink({
    host,
    port,
    token: tb.accessToken,
    deviceProfile,
    flushIntervalMs,
    dryRun,
  });
}
