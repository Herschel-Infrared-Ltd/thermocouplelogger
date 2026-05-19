import { SerialPort } from "serialport";
import { loadConfig, autoDetectAndCreateConfig } from "./config";
import type { AppConfig, DataloggerConfig, ThermocoupleConfig } from "./config";
import { writeFileSync } from "fs";
import CliTable3 from "cli-table3";
import {
  processSerialBuffer,
  CHANNEL_MAP,
  createThermocoupleDefaultName,
  extractDataloggerNumber,
} from "./parser";
// Server will be imported after successful datalogger connection
import pc from "picocolors";
import { tbSinkFromConfig, type TbSink } from "./tb";
import { startMock, defaultMockDataloggers, type MockDatalogger } from "./mock";

/** CLI-only mode check - shows only tables, no server, minimal logging */
const isCliOnly = process.env.CLI_ONLY === "true";

/** Server mode is the default - starts server and shows CLI tables */
const isServerMode = !isCliOnly;

/** Mock mode synthesises HH-4208SD frames in-process instead of opening serial ports. */
const isMockMode = process.env.MOCK === "true";

/** Optional ThingsBoard Gateway MQTT sink. */
let tbSink: TbSink | null = null;

/** Dashboard state tracking */
let dashboardMode = false;
let dashboardLines = 0;

/** Track previous temperature values to detect changes */
let previousTemperatures: { [key: string]: number } = {};

/** ANSI escape codes for terminal control */
const ANSI = {
  MOVE_UP: (lines: number) => `\x1b[${lines}A`,
  CLEAR_LINE: "\x1b[K",
  SAVE_CURSOR: "\x1b[s",
  RESTORE_CURSOR: "\x1b[u",
};

/**
 * Log a message in dashboard mode (appears above the table)
 * In CLI-only mode, suppresses all logging except tables
 */
function dashboardLog(message: string) {
  if (isCliOnly) return;

  if (dashboardMode) {
    // Move up, insert line, move back down
    if (dashboardLines > 0) {
      process.stdout.write(ANSI.MOVE_UP(dashboardLines));
    }
    console.log(message);
  } else {
    console.log(message);
  }
}

/**
 * Log a message for setup/initialization (suppressed in CLI-only mode)
 */
function setupLog(message: string) {
  if (isCliOnly) return;
  console.log(message);
}

/** Map of datalogger ID to serial port instances and buffers */
const dataloggerPorts = new Map<
  string,
  {
    port: SerialPort;
    buffer: string;
    config: DataloggerConfig;
  }
>();

/** Application configuration loaded from config.json */
export let config: AppConfig;

/** All datalogger configurations */
export let activeDataloggers: DataloggerConfig[] = [];

/**
 * Gets all dataloggers from the configuration
 * @returns Array of all datalogger configurations
 */
function getAllDataloggers(): DataloggerConfig[] {
  if (!config || !config.dataloggers || config.dataloggers.length === 0) {
    return [];
  }

  // Return all dataloggers - no filtering
  return config.dataloggers;
}

/**
 * Creates a unique channel key that includes datalogger ID to avoid conflicts
 * @param dataloggerID - ID of the datalogger
 * @param channelHex - Hex channel identifier (e.g., "41", "42")
 * @returns Unique channel key (e.g., "primary:41", "secondary:42")
 */
function createChannelKey(dataloggerID: string, channelHex: string): string {
  return `${dataloggerID}:${channelHex}`;
}

/**
 * Interface for thermocouple channel data storage
 */
interface ChannelData {
  /** Current temperature reading in Celsius */
  temperature: number;
  /** Timestamp of the last received data update */
  lastUpdate: Date;
  /** Configuration object for this channel (optional - auto-generated if not configured) */
  config: ThermocoupleConfig;
  /** Whether this channel was auto-detected from data (vs pre-configured) */
  detected: boolean;
  /** Timestamp when this channel was first detected */
  firstSeen: Date;
  /** Total number of data points received for this channel */
  dataCount: number;
  /** ID of the datalogger this channel belongs to */
  dataloggerID: string;
  /** Name of the datalogger this channel belongs to */
  dataloggerName: string;
}

/**
 * Track temperatures and metadata for all active thermocouple channels
 * Includes both auto-detected and configured channels
 * Key is the hex channel identifier (e.g., "41", "42", etc.)
 */
export const channelData: {
  [key: string]: ChannelData;
} = {};

/**
 * Channel mapping from hex identifiers to decimal channel numbers
 * Re-exported from parser for backward compatibility
 */
export const channelMap = CHANNEL_MAP;

/**
 * Build a synthetic AppConfig + activeDataloggers entries for mock mode.
 * Channels still get auto-detected on first frame, so we only seed the dataloggers themselves.
 */
/**
 * Derive mock channel definitions from a real (or hand-edited) AppConfig.
 * Uses each configured thermocouple's channel number; temperatures are synthesized.
 */
function mocksFromConfig(dataloggers: DataloggerConfig[]): MockDatalogger[] {
  return dataloggers.map((dl) => ({
    id: dl.id,
    name: dl.name,
    channels: dl.thermocouples.map((tc, i) => ({
      channel: tc.channel,
      baseTempC: 20 + (i % 6) * 12, // spread 20..80°C across channels
      driftC: 0.5 + (i % 4) * 0.3,
      label: tc.name,
      type: tc.type,
    })),
  }));
}

function bootstrapMockConfig(mocks: MockDatalogger[]): AppConfig {
  const mockConfig: AppConfig = {
    dataloggers: mocks.map((m) => ({
      id: m.id,
      name: m.name,
      serial: { path: `mock://${m.id}` },
      // Plumb labels through as configured thermocouples so processValidMessage
      // picks the user-provided name instead of the auto-generated D<n>-T<n>.
      thermocouples: m.channels
        .filter((c) => c.label)
        .map((c) => ({
          name: c.label!,
          type: c.type ?? "K",
          channel: c.channel,
        })),
      autoDetected: true,
    })),
  };
  config = mockConfig;
  activeDataloggers = mockConfig.dataloggers;
  return mockConfig;
}

/**
 * Initialize the application with multi-datalogger support
 * Connects to all active dataloggers in parallel
 */
async function initializeApp() {
  if (isMockMode) {
    // Prefer config.json so labels + TB settings come from the same source as the real path.
    const loadedConfig = loadConfig();
    let mocks: MockDatalogger[];
    if (loadedConfig) {
      config = loadedConfig;
      activeDataloggers = getAllDataloggers();
      mocks = mocksFromConfig(activeDataloggers);
      setupLog(
        `${pc.magenta("[mock]")} using config.json: ${pc.green(
          activeDataloggers.length,
        )} datalogger(s)`,
      );
    } else {
      mocks = defaultMockDataloggers();
      bootstrapMockConfig(mocks);
      setupLog(
        `${pc.magenta("[mock]")} no config.json — using defaults (${pc.green(
          mocks.length,
        )} dataloggers, ${pc.green(
          mocks.reduce((n, d) => n + d.channels.length, 0),
        )} channels)`,
      );
    }

    tbSink = tbSinkFromConfig(config.thingsboard);

    // Register stub port entries so processValidMessage can resolve the datalogger.
    for (const dl of activeDataloggers) {
      dataloggerPorts.set(dl.id, {
        port: null as unknown as SerialPort,
        buffer: "",
        config: dl,
      });
    }

    startMock({
      dataloggers: mocks,
      intervalMs: parseInt(process.env.MOCK_INTERVAL_MS || "1000", 10),
      onMessage: (msg, dataloggerID) => {
        if (msg.valid) processValidMessage(msg, dataloggerID);
      },
    });

    if (isServerMode) {
      import("./server");
    }
    return;
  }

  try {
    // Load configuration (read-only)
    const loadedConfig = loadConfig();
    
    if (loadedConfig) {
      // Use existing config
      config = loadedConfig;
      activeDataloggers = getAllDataloggers();
      tbSink = tbSinkFromConfig(config.thingsboard);

      setupLog(
        `Loaded config with ${pc.green(
          config.dataloggers.length
        )} datalogger(s)`
      );
      setupLog(`All dataloggers: ${pc.blue(activeDataloggers.length)}`);

      // Pre-populate channel data for all configured thermocouples from all dataloggers
      for (const datalogger of activeDataloggers) {
        setupLog(
          `  - ${datalogger.name}: ${pc.green(
            datalogger.thermocouples.length
          )} thermocouples @ ${pc.cyan(datalogger.serial.path)}`
        );

        for (const tc of datalogger.thermocouples) {
          const channelHex = Object.keys(channelMap).find(
            (key) => channelMap[key] === tc.channel
          );
          if (channelHex) {
            const channelKey = createChannelKey(datalogger.id, channelHex);
            channelData[channelKey] = {
              temperature: 0,
              lastUpdate: new Date(0),
              config: tc,
              detected: false, // Pre-configured, not detected
              firstSeen: new Date(),
              dataCount: 0,
              dataloggerID: datalogger.id,
              dataloggerName: datalogger.name,
            };
          }
        }
      }
    } else {
      // No config available - run auto-detection
      try {
        config = await autoDetectAndCreateConfig();

        // Save the auto-detected config for future runs
        writeFileSync("./config.json", JSON.stringify(config, null, 2));
        setupLog(`Auto-detected config saved to ${pc.cyan('./config.json')}`);

        activeDataloggers = getAllDataloggers();
        tbSink = tbSinkFromConfig(config.thingsboard);
        setupLog(
          `Auto-detected ${pc.green(activeDataloggers.length)} datalogger(s)`
        );

        // Pre-populate channel data for all configured thermocouples from all dataloggers
        for (const datalogger of activeDataloggers) {
          setupLog(
            `  - ${datalogger.name}: ${pc.green(
              datalogger.thermocouples.length
            )} thermocouples @ ${pc.cyan(datalogger.serial.path)}`
          );

          for (const tc of datalogger.thermocouples) {
            const channelHex = Object.keys(channelMap).find(
              (key) => channelMap[key] === tc.channel
            );
            if (channelHex) {
              const channelKey = createChannelKey(datalogger.id, channelHex);
              channelData[channelKey] = {
                temperature: 0,
                lastUpdate: new Date(0),
                config: tc,
                detected: false, // Pre-configured, not detected
                firstSeen: new Date(),
                dataCount: 0,
                dataloggerID: datalogger.id,
                dataloggerName: datalogger.name,
              };
            }
          }
        }
      } catch (autoDetectError: any) {
        console.error(
          `${pc.red("Setup failed:")} ${autoDetectError.message}`
        );
        console.error("Please connect your HH-4208SD datalogger and run 'npm run setup' to configure.");
        process.exit(1);
      }
    }

    // Initialize serial connections for all active dataloggers in parallel
    // Add a small delay to ensure ports are fully released after auto-detection
    setTimeout(() => {
      initializeDataloggers();
    }, 1000);
  } catch (error) {
    console.error("Failed to initialize app:", error);
    process.exit(1);
  }
}

/**
 * Initialize serial connections for all dataloggers in parallel
 */
function initializeDataloggers() {
  let successCount = 0;
  let failureCount = 0;

  for (const datalogger of activeDataloggers) {
    try {
      setupLog(
        `Connecting to ${datalogger.name} at ${pc.cyan(
          datalogger.serial.path
        )}...`
      );

      const port = new SerialPort({
        path: datalogger.serial.path,
        baudRate: 9600, // HH-4208SD standard baud rate
      });

      // Store port and buffer for this datalogger
      dataloggerPorts.set(datalogger.id, {
        port,
        buffer: "",
        config: datalogger,
      });

      // Set up serial port event handlers for this datalogger
      setupDataloggerHandlers(datalogger.id, port);
      successCount++;
    } catch (serialError: any) {
      setupLog(
        `${pc.red("Failed to connect")} to ${datalogger.name}: ${
          serialError.message
        }`
      );
      
      // Provide specific guidance for common errors
      if (serialError.message.includes("Access denied")) {
        setupLog(`${pc.yellow("Hint:")} Port may be in use. Try disconnecting and reconnecting the device.`);
      } else if (serialError.message.includes("ENOENT")) {
        setupLog(`${pc.yellow("Hint:")} Port not found. Check if device is connected.`);
      }
      
      failureCount++;
    }
  }

  if (successCount === 0) {
    console.error(
      `${pc.red("No dataloggers connected")} - cannot start application`
    );
    console.error("Please connect your HH-4208SD datalogger and run 'npm run setup' to configure.");
    process.exit(1);
  } else {
    setupLog(
      `${pc.green("Successfully connected")} to ${successCount}/${
        activeDataloggers.length
      } dataloggers`
    );

    // Start the server after successful connection (unless CLI-only mode)
    if (isServerMode) {
      import("./server").then(() => {
        // Server startup messages will be shown by the server module
      });
    }
  }
}

/**
 * Set up serial port event handlers for a specific datalogger
 */
function setupDataloggerHandlers(dataloggerID: string, port: SerialPort) {
  const dataloggerInfo = dataloggerPorts.get(dataloggerID);
  if (!dataloggerInfo) {
    setupLog(`Cannot setup handlers: Datalogger ${dataloggerID} not found`);
    return;
  }

  const datalogger = dataloggerInfo.config;

  /**
   * Serial port data event handler
   * Uses shared parser to process incoming data
   */
  port.on("data", (data) => {
    const rawData = data.toString("ascii");

    // Process data using shared parser with this datalogger's buffer
    const result = processSerialBuffer(dataloggerInfo.buffer, rawData);
    dataloggerInfo.buffer = result.buffer;

    // Process each parsed message for this specific datalogger
    result.messages.forEach((parsed) => {
      if (parsed.valid) {
        processValidMessage(parsed, dataloggerID);
      } else {
        dashboardLog(`[${datalogger.name}] Invalid data: ${parsed.error}`);
      }
    });
  });

  /** Serial port error event handler */
  port.on("error", (err) => {
    if (!isCliOnly) {
      console.error("Serial port error:", err);
    }
  });

  /** Serial port open event handler */
  port.on("open", () => {
    dashboardLog("Serial port opened successfully");
    dashboardLog("Monitoring thermocouple data logger...");
  });

  /** Serial port close event handler */
  port.on("close", () => {
    dashboardLog("Serial port closed");
  });
}

/**
 * Process a valid parsed message from the HH-4208SD
 * Handles auto-detection and data updates
 * @param parsed - Validated parsed message from shared parser
 * @param dataloggerID - ID of the datalogger that sent this message
 */
function processValidMessage(
  parsed: import("./parser").ParsedMessage,
  dataloggerID: string
) {
  if (
    !parsed.valid ||
    !parsed.channelHex ||
    !parsed.channelNumber ||
    parsed.temperature === undefined
  ) {
    return;
  }

  const channelKey = createChannelKey(dataloggerID, parsed.channelHex);
  const dataloggerInfo = dataloggerPorts.get(dataloggerID);
  if (!dataloggerInfo) {
    setupLog(
      `Cannot process message: Datalogger ${dataloggerID} not found`
    );
    return;
  }
  const channelNum = parsed.channelNumber;
  const temperature = parsed.temperature;

  // Auto-detect and create channel entry if it doesn't exist
  if (!channelData[channelKey]) {
    // Extract datalogger number and create default thermocouple name
    const dataloggerNumStr = extractDataloggerNumber(
      dataloggerInfo.config.name
    );
    const dataloggerNum = parseInt(dataloggerNumStr, 10);

    // Auto-detect new channel - create entry with sensible defaults
    const defaultConfig: ThermocoupleConfig = {
      name: createThermocoupleDefaultName(dataloggerNum, channelNum),
      type: config.globalSettings?.defaultThermocoupleType || "K",
      channel: channelNum,
    };

    // Check if user config has an override for this channel on this datalogger
    const userConfig = dataloggerInfo.config.thermocouples.find(
      (tc: ThermocoupleConfig) => tc.channel === channelNum
    );
    const finalConfig = userConfig || defaultConfig;

    channelData[channelKey] = {
      temperature: 0,
      lastUpdate: new Date(0),
      config: finalConfig,
      detected: true, // This was auto-detected
      firstSeen: new Date(),
      dataCount: 0,
      dataloggerID: dataloggerID,
      dataloggerName: dataloggerInfo.config.name,
    };

    // Only log auto-detection in server mode for non-zero temperatures
    if (!isCliOnly && temperature !== 0) {
      dashboardLog(
        `[${dataloggerInfo.config.name}] Auto-detected new channel: ${finalConfig.name} (Ch${channelNum}, Type ${finalConfig.type})`
      );
    }
  }

  // Check if temperature changed
  const previousTemp = previousTemperatures[channelKey];
  const temperatureChanged = previousTemp === undefined || previousTemp !== temperature;

  // Update channel data
  channelData[channelKey].temperature = temperature;
  channelData[channelKey].lastUpdate = new Date();
  channelData[channelKey].dataCount++;

  // Update previous temperature tracker
  previousTemperatures[channelKey] = temperature;

  // Push to ThingsBoard Gateway API (one TB device per thermocouple)
  if (tbSink && temperature !== 0) {
    const cfg = channelData[channelKey].config;
    tbSink.ensureDevice(cfg.name, {
      thermocoupleType: cfg.type,
      channel: cfg.channel,
      datalogger: channelData[channelKey].dataloggerName,
      dataloggerID: channelData[channelKey].dataloggerID,
    });
    tbSink.enqueueTelemetry(cfg.name, {
      ts: channelData[channelKey].lastUpdate.getTime(),
      values: { temperature },
    });
  }

  // No individual temperature logging - data is shown in tables only

  // Trigger immediate dashboard update only when temperature changes
  if (dashboardMode && temperatureChanged) {
    showChannelSummary();
  }
}

/**
 * Display a formatted summary of all active thermocouple channels
 * Shows current temperature, channel info, and data age for each detected channel
 * Uses dashboard mode for dynamic updates when available
 * CLI table is disabled in silent mode
 */
function showChannelSummary() {
  // Only show tables in CLI-only mode
  if (!isCliOnly) return;

  if (Object.keys(channelData).length === 0) {
    if (dashboardMode) {
      updateDashboard([]);
    } else {
      console.log("No channels detected yet");
    }
    return;
  }

  // Sort channels by channel number and filter for active channels with non-zero temperatures
  const sortedChannels = Object.entries(channelData)
    .sort((a, b) => {
      // Extract channel number from the key (after the colon for multi-datalogger support)
      const getChannelNum = (key: string) => {
        const parts = key.split(":");
        const hexKey = parts.length > 1 ? parts[1] : parts[0];
        return channelMap[hexKey] || 0;
      };
      return getChannelNum(a[0]) - getChannelNum(b[0]);
    })
    .filter(([, data]) => {
      const age = (Date.now() - data.lastUpdate.getTime()) / 1000;
      const hasData = data.lastUpdate.getTime() > 0;
      const connected = age < 60 && hasData;
      // Filter out channels with 0.0°C as they likely indicate no thermocouple connected
      return connected && data.temperature !== 0;
    });

  if (sortedChannels.length === 0) {
    if (dashboardMode) {
      updateDashboard([]);
    } else {
      console.log("No active channels with readings");
    }
    return;
  }

  // Prepare data for table (without age column)
  const tableData = sortedChannels.map(([, data]) => {
    const dataloggerNum = extractDataloggerNumber(data.dataloggerName);

    return {
      Channel: data.config.channel.toString(),
      Name: data.config.name,
      Type: data.config.type,
      Temperature: `${
        data.temperature >= 0 ? "+" : ""
      }${data.temperature.toFixed(1)}°C`,
      Datalogger: dataloggerNum,
    };
  });

  // Use dashboard mode if available, otherwise fall back to regular logging
  if (dashboardMode) {
    updateDashboard(tableData, [
      "Channel",
      "Name",
      "Type",
      "Temperature",
      "Datalogger",
    ]);
  } else {
    console.log("\n=== Temperature Summary ===");
    showTable(tableData, [
      "Channel",
      "Name",
      "Type",
      "Temperature",
      "Datalogger",
    ]);
  }
}

/**
 * Update the dashboard table using cli-table3 (clears and redraws only table area)
 */
function updateDashboard(data: any[], columns?: string[]) {
  if (!isCliOnly || !dashboardMode) return;

  // Clear previous table output line by line (preserves content above)
  if (dashboardLines > 0) {
    process.stdout.write(ANSI.MOVE_UP(dashboardLines));
    for (let i = 0; i < dashboardLines; i++) {
      process.stdout.write(ANSI.CLEAR_LINE);
      if (i < dashboardLines - 1) {
        process.stdout.write("\n");
      }
    }
    // Move cursor back to start of cleared area
    if (dashboardLines > 1) {
      process.stdout.write(ANSI.MOVE_UP(dashboardLines - 1));
    }
  }

  // Use cli-table3 to display the data
  if (data && data.length > 0) {
    const table = new CliTable3({
      head: columns || Object.keys(data[0]),
    });

    data.forEach((row) => {
      const values = columns
        ? columns.map((col) => row[col])
        : Object.values(row);
      table.push(values);
    });

    const tableString = table.toString();
    console.log(tableString);
    dashboardLines = tableString.split("\n").length;
  } else {
    console.log("No active channels with readings");
    dashboardLines = 1;
  }
}

/**
 * Display a table using cli-table3
 */
function showTable(data: any[], columns?: string[]) {
  if (!isCliOnly || !data || data.length === 0) return;

  const table = new CliTable3({
    head: columns || Object.keys(data[0]),
  });

  data.forEach((row) => {
    const values = columns
      ? columns.map((col) => row[col])
      : Object.values(row);
    table.push(values);
  });

  console.log(table.toString());
}

/** Timer removed - dashboard only updates when temperatures change */

// Initialize the app when the module loads
initializeApp().catch((error) => {
  console.error("Failed to initialize application:", error);
  process.exit(1);
});

// Flush TB sink on shutdown so buffered telemetry isn't dropped
async function shutdown() {
  if (tbSink) {
    try {
      await tbSink.close();
    } catch (err: any) {
      console.error("TB sink close error:", err?.message ?? err);
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Server startup messages will be shown after successful datalogger connection

// Enable dashboard mode for live temperature table updates (only in CLI-only mode)
setTimeout(() => {
  if (isCliOnly) {
    dashboardMode = true;
    showChannelSummary(); // Show initial dashboard
  }
}, 1000);
