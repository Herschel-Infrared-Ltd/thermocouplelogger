import { SerialPort } from "serialport";
import { loadConfig } from "./config";
import type { AppConfig, ThermocoupleConfig } from "./config";
import { logger } from "./logger";
import { processSerialBuffer, CHANNEL_MAP } from "./parser";
import "./server";

/** Serial port instance connected to the thermocouple data logger */
let port: SerialPort;

/** Buffer for accumulating serial data until complete messages are received */
let buffer = "";

/** Application configuration loaded from config.json */
export let config: AppConfig;

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
 * Initialize the application by optionally loading configuration and setting up channel data
 * Config is now optional - app will work with auto-detection if no config exists
 */
function initializeApp() {
  try {
    // Try to load config - if it fails, continue without it
    try {
      config = loadConfig();
      logger.log(
        `Loaded config with ${config.thermocouples.length} thermocouples`
      );
      logger.log(
        `Serial port: ${config.serial.path} @ ${config.serial.baudRate} baud`
      );

      // Pre-populate channel data for configured thermocouples
      for (const tc of config.thermocouples) {
        const channelHex = Object.keys(channelMap).find(
          (key) => channelMap[key] === tc.channel
        );
        if (channelHex) {
          channelData[channelHex] = {
            temperature: 0,
            lastUpdate: new Date(0),
            config: tc,
            detected: false, // Pre-configured, not detected
            firstSeen: new Date(),
            dataCount: 0,
          };
        }
      }
    } catch (configError: any) {
      // Config loading failed - continue with auto-detection only
      logger.warn("No valid configuration found - using auto-detection mode");
      logger.log("Channels will be automatically detected from incoming data");
      
      // Create minimal default config for serial port
      config = {
        serial: {
          path: "/dev/tty.usbserial", // Default that will likely fail
          baudRate: 9600,
        },
        thermocouples: [],
      };
    }

    // Try to initialize serial port with config values
    try {
      port = new SerialPort({
        path: config.serial.path,
        baudRate: config.serial.baudRate,
      });

      // Set up serial port event handlers
      setupSerialPortHandlers();
    } catch (serialError: any) {
      logger.warn(
        "Serial port connection failed (running in demo mode):",
        serialError.message
      );
      logger.log(
        "The application will continue to run for API/web interface testing"
      );
      
      // If serial port fails and we have no config, we're in full demo mode
      if (config.thermocouples.length === 0) {
        logger.log("Demo mode: No config and no serial connection");
      }
    }
  } catch (error) {
    logger.error("Failed to initialize app:", error);
    process.exit(1);
  }
}

/**
 * Set up serial port event handlers
 */
function setupSerialPortHandlers() {
  if (!port) {
    logger.warn("Cannot setup handlers: Serial port not initialized");
    return;
  }

  /**
   * Serial port data event handler
   * Uses shared parser to process incoming data
   */
  port.on("data", (data) => {
    const rawData = data.toString("ascii");
    
    // Process data using shared parser
    const result = processSerialBuffer(buffer, rawData);
    buffer = result.buffer;

    // Process each parsed message
    result.messages.forEach((parsed) => {
      if (parsed.valid) {
        processValidMessage(parsed);
      } else {
        logger.dashboardLog(`Invalid data: ${parsed.error}`);
      }
    });
  });

  /** Serial port error event handler */
  port.on("error", (err) => {
    logger.error("Serial port error:", err);
  });

  /** Serial port open event handler */
  port.on("open", () => {
    logger.dashboardLog("Serial port opened successfully");
    logger.dashboardLog("Monitoring thermocouple data logger...");
  });

  /** Serial port close event handler */
  port.on("close", () => {
    logger.dashboardLog("Serial port closed");
  });
}

/**
 * Process a valid parsed message from the HH-4208SD
 * Handles auto-detection and data updates
 * @param parsed - Validated parsed message from shared parser
 */
function processValidMessage(parsed: import("./parser").ParsedMessage) {
  if (!parsed.valid || !parsed.channelHex || !parsed.channelNumber || parsed.temperature === undefined) {
    return;
  }

  const channelKey = parsed.channelHex;
  const channelNum = parsed.channelNumber;
  const temperature = parsed.temperature;

  // Auto-detect and create channel entry if it doesn't exist
  if (!channelData[channelKey]) {
    // Auto-detect new channel - create entry with sensible defaults
    const defaultConfig: ThermocoupleConfig = {
      name: `Channel ${channelNum}`,
      type: "K", // Most common thermocouple type
      channel: channelNum,
    };
    
    // Check if user config has an override for this channel
    const userConfig = config.thermocouples.find(tc => tc.channel === channelNum);
    const finalConfig = userConfig || defaultConfig;
    
    channelData[channelKey] = {
      temperature: 0,
      lastUpdate: new Date(0),
      config: finalConfig,
      detected: true, // This was auto-detected
      firstSeen: new Date(),
      dataCount: 0,
    };
    
    logger.dashboardLog(`Auto-detected new channel: ${finalConfig.name} (Ch${channelNum}, Type ${finalConfig.type})`);
  }

  // Update channel data
  channelData[channelKey].temperature = temperature;
  channelData[channelKey].lastUpdate = new Date();
  channelData[channelKey].dataCount++;

  const thermocoupleConfig = channelData[channelKey].config;
  const tempDisplay = `${parsed.polarity === '-' ? '-' : ''}${Math.abs(temperature).toFixed(1)}°${parsed.temperatureUnit}`;
  logger.dashboardLog(
    `${thermocoupleConfig.name} (Ch${channelNum}, Type ${
      thermocoupleConfig.type
    }): ${tempDisplay}`
  );

  // Trigger immediate dashboard update after receiving new data
  if (logger.isDashboardMode()) {
    showChannelSummary();
  }
}

/**
 * Display a formatted summary of all active thermocouple channels
 * Shows current temperature, channel info, and data age for each detected channel
 * Uses dashboard mode for dynamic updates when available
 */
function showChannelSummary() {
  let content = "\n=== Temperature Summary ===\n";
  
  if (Object.keys(channelData).length === 0) {
    content += "No channels detected yet\n";
  } else {
    // Sort channels by channel number
    const sortedChannels = Object.entries(channelData).sort((a, b) => {
      const channelA = channelMap[a[0]];
      const channelB = channelMap[b[0]];
      return channelA - channelB;
    });
    
    for (const [, data] of sortedChannels) {
      const age = (Date.now() - data.lastUpdate.getTime()) / 1000;
      const hasData = data.lastUpdate.getTime() > 0;
      const connected = age < 60 && hasData; // Consider connected if data within 60 seconds
      
      if (connected) {
        const tempDisplay = `${data.temperature >= 0 ? '+' : ''}${data.temperature.toFixed(1)}°C`;
        content += `${data.config.name.padEnd(20)} (Ch${data.config.channel
          .toString()
          .padStart(2, " ")}, ${data.config.type}): ${tempDisplay} (${age.toFixed(1)}s ago)\n`;
      } else {
        content += `${data.config.name.padEnd(20)} (Ch${data.config.channel
          .toString()
          .padStart(2, " ")}, ${data.config.type}): --.-°C (disconnected)\n`;
      }
    }
  }
  
  content += "===========================\n";
  
  // Use dashboard mode if available, otherwise fall back to regular logging
  if (logger.isDashboardMode()) {
    logger.updateDashboard(content);
  } else {
    logger.log(content);
  }
}

/** Timer to update dashboard every 2 seconds for live updates */
setInterval(showChannelSummary, 2000);

// Initialize the app when the module loads
initializeApp();

// Log startup message now that both serial monitoring and web server are active
logger.log("Thermocouple Logger started successfully!");
logger.log("- Serial monitoring active");
logger.log("- Web dashboard available at http://localhost:3000");
logger.log("- API endpoints available at http://localhost:3000/api/");
logger.log("- Prometheus metrics at http://localhost:3000/metrics");
logger.log("");

// Enable dashboard mode for live temperature table updates
setTimeout(() => {
  logger.enableDashboard();
  showChannelSummary(); // Show initial dashboard
}, 1000);
