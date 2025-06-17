import { SerialPort } from "serialport";
import { loadConfig } from "./config";
import type { AppConfig, ThermocoupleConfig } from "./config";

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
  /** Configuration object for this channel */
  config: ThermocoupleConfig;
}

/**
 * Track temperatures and metadata for configured thermocouples
 * Key is the hex channel identifier (e.g., "41", "42", etc.)
 */
export const channelData: {
  [key: string]: ChannelData;
} = {};

/**
 * Channel mapping from hex identifiers to decimal channel numbers
 * Used to convert between the hex values received from the hardware
 * and the human-readable channel numbers (1-12)
 */
export const channelMap: { [key: string]: number } = {
  "41": 1,
  "42": 2,
  "43": 3,
  "44": 4,
  "45": 5,
  "46": 6,
  "47": 7,
  "48": 8,
  "49": 9,
  "4A": 10,
  "4B": 11,
  "4C": 12,
};

/**
 * Initialize the application by loading configuration and setting up channel data
 * @throws {Error} If configuration loading fails, causing process exit
 */
function initializeApp() {
  try {
    config = loadConfig();
    console.log(
      `Loaded config with ${config.thermocouples.length} thermocouples`
    );
    console.log(
      `Serial port: ${config.serial.path} @ ${config.serial.baudRate} baud`
    );

    // Initialize channel data for configured thermocouples
    for (const tc of config.thermocouples) {
      const channelHex = Object.keys(channelMap).find(
        (key) => channelMap[key] === tc.channel
      );
      if (channelHex) {
        channelData[channelHex] = {
          temperature: 0,
          lastUpdate: new Date(0),
          config: tc,
        };
      }
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
      console.warn(
        "Serial port connection failed (running in demo mode):",
        serialError.message
      );
      console.log(
        "The application will continue to run for API/web interface testing"
      );
    }
  } catch (error) {
    console.error("Failed to initialize app:", error);
    process.exit(1);
  }
}

/**
 * Set up serial port event handlers
 */
function setupSerialPortHandlers() {
  if (!port) {
    console.warn("Cannot setup handlers: Serial port not initialized");
    return;
  }

  /**
   * Serial port data event handler
   * Accumulates incoming data in a buffer and processes complete messages
   */
  port.on("data", (data) => {
    // Convert buffer to string and append to our buffer
    buffer += data.toString("ascii");

    // Process complete messages (ending with \r)
    let messages = buffer.split("\r");

    // Keep the last incomplete message in buffer
    buffer = messages.pop() || "";

    // Process each complete message
    messages.forEach((message) => {
      if (message.length > 0) {
        parseThermocoupleData(message);
      }
    });
  });

  /** Serial port error event handler */
  port.on("error", (err) => {
    console.error("Serial port error:", err);
  });

  /** Serial port open event handler */
  port.on("open", () => {
    console.log("Serial port opened successfully");
    console.log("Monitoring thermocouple data logger...\n");
  });

  /** Serial port close event handler */
  port.on("close", () => {
    console.log("Serial port closed");
  });
}

/**
 * Parse a complete thermocouple data message from the serial port
 * Expected format: STX + 2-char hex channel ID + sensor data + temperature (last 3 digits)
 * @param message - Complete message string to parse
 */
function parseThermocoupleData(message: string) {
  // Check if message starts with STX (0x02)
  if (message.charCodeAt(0) === 0x02) {
    // Remove STX character
    const data = message.substring(1);

    // Extract channel identifier (first 2 characters)
    const channelHex = data.substring(0, 2);
    const channelNum = channelMap[channelHex.toUpperCase()];

    if (!channelNum) {
      console.log("Unknown channel:", channelHex);
      return;
    }

    // Check if this channel is configured
    const channelKey = channelHex.toUpperCase();
    if (!channelData[channelKey]) {
      // Channel not configured, skip
      return;
    }

    // Extract the remaining data
    const sensorData = data.substring(2);

    // Parse temperature from last 3 digits (assuming temperature * 10)
    const tempRaw = sensorData.slice(-3);
    const temperature = parseInt(tempRaw, 10) / 10; // Convert back to actual temperature

    // Update channel data
    channelData[channelKey].temperature = temperature;
    channelData[channelKey].lastUpdate = new Date();

    const thermocoupleConfig = channelData[channelKey].config;
    console.log(
      `${thermocoupleConfig.name} (Ch${channelNum}, Type ${
        thermocoupleConfig.type
      }): ${temperature.toFixed(1)}°C`
    );

    // Every few readings, show a summary of all channels
    if (Math.random() < 0.1) {
      // Show summary ~10% of the time
      showChannelSummary();
    }
  }
}

/**
 * Display a formatted summary of all configured thermocouple channels
 * Shows current temperature, channel info, and data age for each configured channel
 */
function showChannelSummary() {
  console.log("\n=== Temperature Summary ===");
  for (const tc of config.thermocouples) {
    const channelHex = Object.keys(channelMap).find(
      (key) => channelMap[key] === tc.channel
    );
    if (channelHex && channelData[channelHex]) {
      const data = channelData[channelHex];
      const age = (Date.now() - data.lastUpdate.getTime()) / 1000;
      const hasData = data.lastUpdate.getTime() > 0;
      if (hasData) {
        console.log(
          `${tc.name.padEnd(20)} (Ch${tc.channel
            .toString()
            .padStart(2, " ")}, ${tc.type}): ${data.temperature.toFixed(
            2
          )}°C (${age.toFixed(1)}s ago)`
        );
      } else {
        console.log(
          `${tc.name.padEnd(20)} (Ch${tc.channel
            .toString()
            .padStart(2, " ")}, ${tc.type}): --.-°C (no data)`
        );
      }
    } else {
      console.log(
        `${tc.name.padEnd(20)} (Ch${tc.channel.toString().padStart(2, " ")}, ${
          tc.type
        }): --.-°C (not connected)`
      );
    }
  }
  console.log("===========================\n");
}

/** Timer to show channel summary every 30 seconds */
setInterval(showChannelSummary, 30000);

// Initialize the app when the module loads
initializeApp();
