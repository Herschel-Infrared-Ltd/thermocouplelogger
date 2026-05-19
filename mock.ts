import { CHANNEL_MAP } from "./parser";
import type { ParsedMessage } from "./parser";
import { processSerialBuffer } from "./parser";

export interface MockChannel {
  /** Decimal channel number (1-12). */
  channel: number;
  /** Center of the temperature random walk, in Celsius. */
  baseTempC: number;
  /** Max +/- step per tick. */
  driftC?: number;
  /** Optional human label; becomes the TB device name. Defaults to D<dl>-T<ch>. */
  label?: string;
  /** Optional thermocouple type. Defaults to "K". */
  type?: string;
}

export interface MockDatalogger {
  id: string;
  name: string;
  channels: MockChannel[];
}

export interface MockOptions {
  dataloggers: MockDatalogger[];
  /** ms between full sweeps of all channels on all dataloggers. */
  intervalMs: number;
  /** Receives parsed messages with their originating datalogger id. */
  onMessage: (msg: ParsedMessage, dataloggerID: string) => void;
}

/**
 * Build an HH-4208SD frame for one channel reading.
 * Format: STX + '4' + channelHex2nd + tempUnit(01=C) + polarity + decimal + sensorData + tempDigits + CR
 * The parser only needs STX, the 2-char channel id, and the last 3 digits as temperature*10.
 */
function buildFrame(channelHex: string, tempC: number): string {
  const polarity = tempC < 0 ? "1" : "0";
  const magnitude = Math.abs(tempC);
  const tempScaled = Math.round(magnitude * 10);
  const clamped = Math.min(tempScaled, 999);
  const tempDigits = clamped.toString().padStart(3, "0");
  const stx = String.fromCharCode(0x02);
  // 4X TTPP D ddd  -> 4 + channel hex 2nd char + '01' (C) + polarity + decimal '1' + padding + 3-digit temp
  return `${stx}4${channelHex[1]}01${polarity}1   ${tempDigits}\r`;
}

const HEX_FOR_CHANNEL: Record<number, string> = Object.fromEntries(
  Object.entries(CHANNEL_MAP).map(([hex, ch]) => [ch, hex]),
);

export function startMock(opts: MockOptions): () => void {
  const buffers = new Map<string, string>();
  const temps = new Map<string, number>();

  for (const dl of opts.dataloggers) {
    buffers.set(dl.id, "");
    for (const ch of dl.channels) {
      temps.set(`${dl.id}:${ch.channel}`, ch.baseTempC);
    }
  }

  const tick = () => {
    for (const dl of opts.dataloggers) {
      let frames = "";
      for (const ch of dl.channels) {
        const key = `${dl.id}:${ch.channel}`;
        const prev = temps.get(key) ?? ch.baseTempC;
        const drift = ch.driftC ?? 0.3;
        const next = prev + (Math.random() * 2 - 1) * drift;
        temps.set(key, next);
        const hex = HEX_FOR_CHANNEL[ch.channel];
        if (!hex) continue;
        frames += buildFrame(hex, next);
      }
      const prevBuf = buffers.get(dl.id) ?? "";
      const result = processSerialBuffer(prevBuf, frames);
      buffers.set(dl.id, result.buffer);
      for (const msg of result.messages) {
        opts.onMessage(msg, dl.id);
      }
    }
  };

  // Fire once immediately so first temps land without waiting a full interval.
  tick();
  const handle = setInterval(tick, opts.intervalMs);

  return () => clearInterval(handle);
}

export function defaultMockDataloggers(): MockDatalogger[] {
  // Parser caps at 99.9°C (3-digit field /10); keep mocks safely below.
  // Labels prefixed "Mock-" so anything that lands in prod is obvious test data.
  const primary: MockChannel[] = Array.from({ length: 12 }, (_, i) => ({
    channel: i + 1,
    baseTempC: 20 + i * 5,
    driftC: 0.4 + (i % 3) * 0.3,
    label: `Mock-D1-T${i + 1}`,
  }));
  const secondary: MockChannel[] = Array.from({ length: 9 }, (_, i) => ({
    channel: i + 1,
    baseTempC: 25 + i * 6,
    driftC: 0.5 + (i % 3) * 0.4,
    label: `Mock-D2-T${i + 1}`,
  }));
  return [
    { id: "primary", name: "Datalogger 1", channels: primary },
    { id: "secondary", name: "Datalogger 2", channels: secondary },
  ];
}
