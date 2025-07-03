import { existsSync, writeFileSync, readFileSync } from "fs";
import { SerialPort } from "serialport";
import * as readline from "readline";
import * as os from "os";
import { processSerialBuffer, createDefaultDataloggerConfig } from "./parser";
import pc from 'picocolors';

/**
 * Interface for scored serial port with likelihood rating
 */
interface ScoredPort {
  /** Port information from SerialPort.list() */
  port: any;
  /** Likelihood score (0-100) of being an HH-4208SD datalogger */
  score: number;
  /** Human-readable reason for the score */
  reason: string;
}

/**
 * Configuration interface for serial port connection
 */
export interface SerialConfig {
  /** Serial port path (e.g., '/dev/tty.usbserial-AB0N89MV' or 'COM3') */
  path: string;
}

/**
 * Configuration interface for a single thermocouple channel
 */
export interface ThermocoupleConfig {
  /** Human-readable name for the thermocouple */
  name: string;
  /** Thermocouple type (e.g., 'K', 'J', 'T', 'E', etc.) */
  type: string;
  /** Channel number (1-12) corresponding to the hardware channel */
  channel: number;
}

/**
 * Configuration interface for a single datalogger
 */
export interface DataloggerConfig {
  /** Unique identifier for this datalogger */
  id: string;
  /** Human-readable name for this datalogger */
  name: string;
  /** Serial port configuration */
  serial: SerialConfig;
  /** Array of configured thermocouple channels for this datalogger */
  thermocouples: ThermocoupleConfig[];
  /** Last time this datalogger was seen (optional) */
  lastSeen?: Date;
  /** Whether this datalogger was auto-detected vs manually configured */
  autoDetected?: boolean;
}

/**
 * Main application configuration interface (supports multiple dataloggers)
 */
export interface AppConfig {
  /** Array of configured dataloggers */
  dataloggers: DataloggerConfig[];
  /** Global settings that apply to all dataloggers */
  globalSettings?: {
    /** Connection timeout in seconds */
    connectionTimeout?: number;
    /** Default thermocouple type for auto-detected channels */
    defaultThermocoupleType?: string;
  };
}


/** Path to the configuration file */
const CONFIG_PATH = "./config.json";

// Channel validation constants imported from shared parser

/**
 * Scores a serial port based on likelihood of being an HH-4208SD datalogger
 * @param port - Port information from SerialPort.list()
 * @returns Scored port with likelihood rating and reasoning
 */
function scorePort(port: any): ScoredPort {
  let score = 0;
  const reasons: string[] = [];
  
  // Vendor ID based scoring (strict - only known compatible chips)
  const vid = port.vendorId?.toLowerCase();
  if (vid === "0403") {
    score += 95;
    reasons.push("FTDI chip");
  } else if (vid === "10c4") {
    score += 70;
    reasons.push("Silicon Labs CP210x");
  } else {
    // Penalty for unknown or incompatible chips
    score -= 30;
    reasons.push("Unknown/incompatible chip");
  }
  
  // Port path based scoring
  const path = port.path?.toLowerCase() || "";
  if (path.includes("usbserial")) {
    score += 10;
    reasons.push("USB-serial device");
  } else if (path.includes("usbmodem")) {
    score += 5;
    reasons.push("USB modem/CDC device");
  }
  
  if (path.includes("ftdi")) {
    score += 10;
    reasons.push("FTDI in path");
  }
  
  if (path.includes("ttyusb")) {
    score += 5;
    reasons.push("Linux USB serial");
  } else if (path.includes("ttyacm")) {
    score += 5;
    reasons.push("Linux CDC ACM");
  }
  
  // Manufacturer string bonus
  const manufacturer = port.manufacturer?.toLowerCase() || "";
  if (manufacturer.includes("ftdi")) {
    score += 15;
    reasons.push("FTDI manufacturer");
  } else if (manufacturer.includes("silicon labs")) {
    score += 10;
    reasons.push("Silicon Labs manufacturer");
  } else if (manufacturer.includes("prolific")) {
    score += 5;
    reasons.push("Prolific manufacturer");
  }
  
  // Exclusions (penalty scoring)
  if (path.includes("bluetooth")) {
    score -= 50;
    reasons.push("Bluetooth device (excluded)");
  }
  
  if (path.includes("debug")) {
    score -= 30;
    reasons.push("Debug device (excluded)");
  }
  
  // Platform-specific built-in port detection
  const platform = os.platform();
  if (platform === "darwin" && (path.includes("bluetooth") || path.includes("debug"))) {
    score -= 20;
    reasons.push("Built-in macOS port");
  }
  
  // Ensure score doesn't go negative
  score = Math.max(0, score);
  
  const reason = reasons.length > 0 ? reasons.join(", ") : "Unknown device";
  
  return {
    port,
    score,
    reason
  };
}

/**
 * Tests a serial port for valid HH-4208SD thermocouple data with shorter timeout for auto-detection
 * @param portPath - The serial port path to test
 * @param timeoutMs - Timeout in milliseconds (default: 10000 for auto-detection)
 * @param silent - Whether to suppress console output during testing
 * @returns Promise resolving to object with port path and discovered channels
 * @throws Error with specific guidance if no valid data found
 */
async function testPortForDataQuick(
  portPath: string,
  timeoutMs: number = 10000,
  silent: boolean = true
): Promise<{
  path: string;
  channels: { hex: string; number: number; temperature: number }[];
}> {
  if (!silent) {
    console.log(`\nTesting ${portPath} for valid thermocouple data...`);
    console.log(`Looking for HH-4208SD data format (up to ${timeoutMs/1000} seconds)...`);
  }
  
  return new Promise((resolve, reject) => {
    let port: SerialPort;
    let buffer = "";
    let dataReceived = false;
    let timeout: NodeJS.Timeout;
    let discoveredChannels = new Map<
      string,
      { hex: string; number: number; temperature: number }
    >();
    let allChannelsSeen = new Set<string>();

    // Set up timeout for data detection
    timeout = setTimeout(() => {
      cleanup();
      if (!dataReceived) {
        reject(new Error(`No data received from ${portPath}`));
      } else if (discoveredChannels.size === 0) {
        reject(new Error(`Data received from ${portPath} but format not recognized as HH-4208SD`));
      } else {
        // Success - found valid channels
        const sortedChannels = Array.from(discoveredChannels.values()).sort(
          (a, b) => a.number - b.number
        );
        resolve({path: portPath, channels: sortedChannels});
      }
    }, timeoutMs);
    
    function cleanup() {
      if (timeout) clearTimeout(timeout);
      if (port && port.isOpen) {
        port.close();
      }
    }
    
    try {
      // Open port for testing
      port = new SerialPort({
        path: portPath,
        baudRate: 9600, // Standard HH-4208SD baud rate
      });
      
      port.on("data", (data: Buffer) => {
        dataReceived = true;
        const rawData = data.toString("ascii");
        
        // Use shared parser to process data
        const result = processSerialBuffer(buffer, rawData);
        buffer = result.buffer;
        
        // Check for any valid messages and track all channels
        for (const parsed of result.messages) {
          if (parsed.valid && parsed.channelHex && parsed.channelNumber) {
            const channelId = parsed.channelHex;
            
            // Track that we've seen this channel
            allChannelsSeen.add(channelId);
            
            // Only store channels with temperature readings that indicate connected thermocouples
            if (
              parsed.temperature !== undefined &&
              parsed.temperature !== null &&
              parsed.temperature !== 0
            ) {
              if (!discoveredChannels.has(channelId)) {
                discoveredChannels.set(channelId, {
                  hex: parsed.channelHex,
                  number: parsed.channelNumber,
                  temperature: parsed.temperature,
                });
                if (!silent) {
                  console.log(
                    ` Discovered channel: ${parsed.channelHex} (Channel ${parsed.channelNumber}) - ${parsed.temperature}°C`
                  );
                }
              }
            }
            
            // Exit early if we've seen all 12 possible channels
            if (allChannelsSeen.size === 12) {
              cleanup();
              const sortedChannels = Array.from(discoveredChannels.values()).sort(
                (a, b) => a.number - b.number
              );
              resolve({path: portPath, channels: sortedChannels});
              return;
            }
          }
        }
      });
      
      port.on("error", (err: Error) => {
        cleanup();
        reject(new Error(`Cannot open ${portPath}: ${err.message}`));
      });
      
    } catch (error: any) {
      cleanup();
      reject(new Error(`Failed to test ${portPath}: ${error.message}`));
    }
  });
}

/**
 * Tests a serial port for valid HH-4208SD thermocouple data (full 30-second test)
 * Attempts to read data for up to 30 seconds and collects all active channels
 * @param portPath - The serial port path to test
 * @returns Promise resolving to object with port path and discovered channels
 * @throws Error with specific guidance if no valid data found
 */
async function testPortForData(
  portPath: string
): Promise<{
  path: string;
  channels: { hex: string; number: number; temperature: number }[];
}> {
  console.log(`\nTesting ${portPath} for valid thermocouple data...`);
  console.log(
    "Looking for HH-4208SD data format (up to 30 seconds)..."
  );
  console.log("Collecting all active channels...");

  return new Promise((resolve, reject) => {
    let port: SerialPort;
    let buffer = "";
    let dataReceived = false;
    let timeout: NodeJS.Timeout;
    let discoveredChannels = new Map<
      string,
      { hex: string; number: number; temperature: number }
    >();
    let allChannelsSeen = new Set<string>(); // Track all channels seen, regardless of temperature validity

    // Set up timeout for data detection
    timeout = setTimeout(() => {
      cleanup();
      if (!dataReceived) {
        reject(
          new Error(
            `No data received from ${portPath}\n\n` +
              `Please check your HH-4208SD configuration:\n` +
              `1. Set sampling rate to "1" (1 second intervals)\n` +
              `2. Set USB cable switch to position "2" (photo mode)\n` +
              `3. Ensure data logging is enabled on the device\n` +
              `4. Verify thermocouple connections\n\n` +
              `The device should be continuously outputting temperature data.`
          )
        );
      } else if (discoveredChannels.size === 0) {
        reject(
          new Error(
            `Data received from ${portPath} but format is not recognized as HH-4208SD\n\n` +
              `Please verify:\n` +
              `1. USB cable switch is set to position "2" (photo mode)\n` +
              `2. Device is HH-4208SD thermocouple data logger\n` +
              `3. Sampling rate is set to "1" second\n\n` +
              `Expected format: STX + 2-digit hex channel + sensor data`
          )
        );
      } else {
        console.log(` Channel discovery completed on ${portPath}`);
        console.log(
          `Found ${discoveredChannels.size} active channels:`
        );

        // Sort channels by channel number for display
        const sortedChannels = Array.from(discoveredChannels.values()).sort(
          (a, b) => a.number - b.number
        );
        sortedChannels.forEach((ch) => {
          console.log(
            `  - Channel ${ch.hex} (Channel ${ch.number}): ${ch.temperature}°C`
          );
        });

        resolve({ path: portPath, channels: sortedChannels });
      }
    }, 30000); // 30 second timeout

    function cleanup() {
      if (timeout) clearTimeout(timeout);
      if (port && port.isOpen) {
        port.close();
      }
    }

    try {
      // Open port for testing
      port = new SerialPort({
        path: portPath,
        baudRate: 9600, // Standard HH-4208SD baud rate
      });

      port.on("data", (data: Buffer) => {
        dataReceived = true;
        const rawData = data.toString("ascii");

        // Use shared parser to process data
        const result = processSerialBuffer(buffer, rawData);
        buffer = result.buffer;

        // Check for any valid messages and track all channels
        for (const parsed of result.messages) {
          if (parsed.valid && parsed.channelHex && parsed.channelNumber) {
            const channelId = parsed.channelHex;

            // Track that we've seen this channel
            allChannelsSeen.add(channelId);

            // Only store channels with temperature readings that indicate connected thermocouples
            // Note: Exactly 0°C often indicates no thermocouple connected in HH-4208SD
            if (
              parsed.temperature !== undefined &&
              parsed.temperature !== null &&
              parsed.temperature !== 0
            ) {
              if (!discoveredChannels.has(channelId)) {
                discoveredChannels.set(channelId, {
                  hex: parsed.channelHex,
                  number: parsed.channelNumber,
                  temperature: parsed.temperature,
                });
                console.log(
                  ` Discovered channel: ${parsed.channelHex} (Channel ${parsed.channelNumber}) - ${parsed.temperature}°C`
                );
              }
            }

            // Exit early if we've seen all 12 possible channels
            if (allChannelsSeen.size === 12) {
              cleanup();
              console.log(` All 12 channels detected on ${portPath}`);
              console.log(
                `Found ${discoveredChannels.size} channels with valid temperatures:`
              );

              // Sort channels by channel number for display
              const sortedChannels = Array.from(
                discoveredChannels.values()
              ).sort((a, b) => a.number - b.number);
              sortedChannels.forEach((ch) => {
                console.log(
                  `  - Channel ${ch.hex} (Channel ${ch.number}): ${ch.temperature}°C`
                );
              });

              resolve({ path: portPath, channels: sortedChannels });
              return;
            }
          }
        }
      });

      port.on("error", (err: Error) => {
        cleanup();
        reject(new Error(`Cannot open ${portPath}: ${err.message}`));
      });

      port.on("open", () => {
        console.log(`Port ${portPath} opened, listening for data...`);
      });
    } catch (error: any) {
      cleanup();
      reject(new Error(`Failed to test ${portPath}: ${error.message}`));
    }
  });
}

/**
 * Automatically detects HH-4208SD dataloggers by scoring and testing ports
 * @returns Promise resolving to array of validated dataloggers found
 */
export async function autoDetectDataloggers(): Promise<{
  path: string;
  channels: { hex: string; number: number; temperature: number }[];
  score: number;
  reason: string;
}[]> {
  // Scan silently - main status shown in index.ts
  
  try {
    // Get all available ports
    const ports = await SerialPort.list();
    
    if (ports.length === 0) {
      throw new Error("No serial ports found. Please connect your datalogger and try again.");
    }
    
    // Score all ports
    const scoredPorts = ports.map(scorePort).filter(sp => sp.score > 0);
    
    // Sort by score (highest first)
    scoredPorts.sort((a, b) => b.score - a.score);
    
    if (scoredPorts.length === 0) {
      throw new Error("No likely datalogger ports found. Please check your device connection.");
    }
    
    // Show detected ports with simplified output
    scoredPorts.forEach((sp, index) => {
      const confidence = sp.score >= 90 ? "Very High" : 
                        sp.score >= 60 ? "High" : 
                        sp.score >= 40 ? "Medium" : "Low";
      console.log(`  ${index + 1}. ${pc.cyan(sp.port.path)} - Score: ${sp.score} (${confidence})`);
    });
    
    // Auto-test high-confidence ports (score >= 60)
    const candidatePorts = scoredPorts.filter(sp => sp.score >= 60);
    // Auto-testing ports (status shown in main output)
    
    const validDataloggers = [];
    
    for (const scoredPort of candidatePorts) {
      try {
        console.log(`Testing ${pc.cyan(scoredPort.port.path)}...`);
        const result = await testPortForDataQuick(scoredPort.port.path, 8000, true);
        
        if (result.channels.length > 0) {
          validDataloggers.push({
            ...result,
            score: scoredPort.score,
            reason: scoredPort.reason
          });
        }
      } catch (error: any) {
        // Port test failed - continue silently
      }
    }
    
    return validDataloggers;
    
  } catch (error: any) {
    console.error(`Error during auto-detection: ${error.message}`);
    throw error;
  }
}

/**
 * Validates a thermocouple configuration object
 * @param tc - Thermocouple configuration to validate
 * @throws {Error} If the thermocouple configuration is invalid
 */
function validateThermocoupleConfig(tc: any): void {
  if (
    typeof tc.name !== "string" ||
    typeof tc.type !== "string" ||
    typeof tc.channel !== "number" ||
    tc.channel < 1 ||
    tc.channel > 12
  ) {
    throw new Error(`Invalid thermocouple config: ${JSON.stringify(tc)}`);
  }
}

/**
 * Validates a datalogger configuration object
 * @param datalogger - Datalogger configuration to validate
 * @throws {Error} If the datalogger configuration is invalid
 */
function validateDataloggerConfig(datalogger: any): void {
  if (
    typeof datalogger.id !== "string" ||
    typeof datalogger.name !== "string" ||
    !datalogger.serial ||
    typeof datalogger.serial.path !== "string" ||
    !Array.isArray(datalogger.thermocouples)
  ) {
    throw new Error(`Invalid datalogger config: ${JSON.stringify(datalogger)}`);
  }
  
  for (const tc of datalogger.thermocouples) {
    validateThermocoupleConfig(tc);
  }
}


/**
 * Validates the configuration object structure and values
 * @param config - The configuration object to validate
 * @throws {Error} If the configuration is invalid
 */
function validateConfig(config: any): asserts config is AppConfig {
  if (!config || !Array.isArray(config.dataloggers)) {
    throw new Error("Config must have a 'dataloggers' array");
  }
  
  if (config.dataloggers.length === 0) {
    throw new Error("Config must have at least one datalogger");
  }
  
  for (const datalogger of config.dataloggers) {
    validateDataloggerConfig(datalogger);
  }
}

/**
 * Lists available serial ports using SerialPort.list() and prompts user to select one
 * @returns Promise resolving to the selected serial port path and discovered channels
 */
async function promptForSerialPort(): Promise<{
  path: string;
  channels: { hex: string; number: number; temperature: number }[];
}> {
  console.log("\nScanning for available serial ports...");

  try {
    // Use SerialPort.list() to get port information
    const ports = await SerialPort.list();

    // Filter out system ports that are unlikely to be the thermocouple logger
    const filteredPorts = ports.filter((port) => {
      const path = port.path.toLowerCase();
      const platform = os.platform();

      if (platform === "darwin") {
        // On macOS, filter out built-in ports and focus on USB devices
        return (
          path.includes("usbserial") ||
          path.includes("usbmodem") ||
          (port.manufacturer &&
            !path.includes("bluetooth") &&
            !path.includes("debug"))
        );
      } else if (platform === "win32") {
        // On Windows, look for COM ports
        return path.startsWith("com");
      } else {
        // On Linux, look for USB and ACM devices
        return (
          path.includes("usb") ||
          path.includes("acm") ||
          path.includes("ttyusb")
        );
      }
    });

    const portsToShow = filteredPorts.length > 0 ? filteredPorts : ports;

    if (portsToShow.length === 0) {
      throw new Error(
        "No serial ports found. Please connect your HH-4208SD thermocouple logger and try again."
      );
    }

    console.log("\nAvailable serial ports:");
    portsToShow.forEach((port, index) => {
      const manufacturer = port.manufacturer || "Unknown";
      const productId = port.productId || "N/A";
      const vendorId = port.vendorId || "N/A";
      const serialNumber = port.serialNumber ? ` SN:${port.serialNumber}` : "";

      // Add helpful device type hints
      let deviceHint = "";
      if (port.vendorId === "0403") {
        deviceHint = " [FTDI - Compatible with HH-4208SD]";
      } else if (port.vendorId === "10c4") {
        deviceHint = " [Silicon Labs CP210x]";
      } else if (port.vendorId === "1a86") {
        deviceHint = " [CH340/CH341 USB Serial]";
      } else if (manufacturer && manufacturer.toLowerCase().includes("ftdi")) {
        deviceHint = " [FTDI - Compatible with HH-4208SD]";
      }

      console.log(
        `  ${index + 1}. ${
          port.path
        } (${manufacturer}, VID:${vendorId}, PID:${productId}${serialNumber})${deviceHint}`
      );
    });

    // If only one likely port, offer to auto-select
    if (portsToShow.length === 1) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const autoSelect = await new Promise<boolean>((resolve) => {
        rl.question(
          `\nAuto-select the only available port "${portsToShow[0].path}"? (Y/n): `,
          (answer: string) => {
            rl.close();
            resolve(answer.trim().toLowerCase() !== "n");
          }
        );
      });

      if (autoSelect) {
        console.log(`Selected: ${portsToShow[0].path}`);
        // Test the auto-selected port for valid HH-4208SD data
        try {
          const result = await testPortForData(portsToShow[0].path);
          return result;
        } catch (error: any) {
          console.error(`Data validation failed: ${error.message}`);
          // Ask user if they want to continue anyway
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const continueAnyway = await new Promise<boolean>((resolve) => {
            rl.question(
              `\nContinue with ${portsToShow[0].path} anyway? (y/N): `,
              (answer: string) => {
                rl.close();
                resolve(answer.trim().toLowerCase() === "y");
              }
            );
          });

          if (continueAnyway) {
            console.log(
              `Continuing with ${portsToShow[0].path} - data validation can be done later`
            );
            return { path: portsToShow[0].path, channels: [] };
          } else {
            throw new Error("Setup cancelled by user");
          }
        }
      }
    }

    // Create readline interface for user input
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Prompt user to select a port
    const selectedIndex = await new Promise<number>((resolve) => {
      rl.question(
        `\nPlease select a serial port (1-${portsToShow.length}): `,
        (answer: string) => {
          const index = parseInt(answer.trim()) - 1;
          rl.close();
          resolve(index);
        }
      );
    });

    // Validate selection
    if (
      selectedIndex < 0 ||
      selectedIndex >= portsToShow.length ||
      isNaN(selectedIndex)
    ) {
      throw new Error(
        "Invalid selection. Please restart and select a valid port number."
      );
    }

    const selectedPort = portsToShow[selectedIndex];
    console.log(`\nSelected: ${selectedPort.path}`);
    if (selectedPort.manufacturer) {
      console.log(`Device: ${selectedPort.manufacturer}`);
    }

    // Test the selected port for valid HH-4208SD data
    try {
      const result = await testPortForData(selectedPort.path);
      return result;
    } catch (error: any) {
      console.error(`Data validation failed: ${error.message}`);
      // Ask user if they want to continue anyway
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const continueAnyway = await new Promise<boolean>((resolve) => {
        rl.question(
          `\nContinue with ${selectedPort.path} anyway? (y/N): `,
          (answer: string) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "y");
          }
        );
      });

      if (continueAnyway) {
        console.log(
          `Continuing with ${selectedPort.path} - data validation can be done later`
        );
        return { path: selectedPort.path, channels: [] };
      } else {
        throw new Error("Setup cancelled by user");
      }
    }
  } catch (error: any) {
    console.error(`Error listing serial ports: ${error.message}`);
    throw new Error(
      "Failed to detect serial ports. Please check your device connection and try again."
    );
  }
}

/**
 * Loads the application configuration from the config.json file
 * If the file doesn't exist or is invalid, returns a minimal default configuration
 * This allows the app to run with pure auto-detection if no config is available
 * @returns The loaded configuration or a minimal default
 */
export function loadConfig(): AppConfig {
  // Create minimal default configuration for fallback
  const defaultConfig: AppConfig = {
    dataloggers: [{
      id: "default",
      name: "Default Datalogger",
      serial: {
        path: "/dev/tty.usbserial", // Default path (likely to fail, will trigger serial error)
      },
      thermocouples: [], // Empty - will use pure auto-detection
      autoDetected: false
    }],
    globalSettings: {
      connectionTimeout: 60,
      defaultThermocoupleType: "K"
    }
  };

  if (!existsSync(CONFIG_PATH)) {
    // Return default config silently - startup messages handled in index.ts
    return defaultConfig;
  }

  try {
    const text = readFileSync(CONFIG_PATH, "utf-8");
    const parsedConfig = JSON.parse(text);
    
    // Validate configuration
    validateConfig(parsedConfig);
    return parsedConfig;
    
  } catch (err: any) {
    console.warn(`config.json is invalid: ${err.message || err}`);
    console.log(`Falling back to auto-detection mode`);
    console.log(
      `Fix config.json or delete it and run 'npm run setup' to reconfigure`
    );
    return defaultConfig;
  }
}

/**
 * Setup command to generate configuration interactively with intelligent auto-detection
 * Uses smart port detection and supports multiple dataloggers
 * @returns Promise resolving to the generated configuration
 */
export async function setupConfig(): Promise<AppConfig> {
  console.log("\nHH-4208SD Thermocouple Logger Setup");
  console.log("\nIntelligent datalogger detection and configuration");
  console.log("This setup will automatically detect and configure your HH-4208SD dataloggers.");
  console.log("\nIMPORTANT - HH-4208SD Device Configuration:");
  console.log("1. Set sampling rate to '1' (1 second intervals)");
  console.log("2. Set USB cable switch to position '2' (photo mode)");
  console.log("3. Ensure data logging is enabled on the device");
  console.log("4. Connect thermocouples to desired channels\n");

  try {
    // Use intelligent auto-detection
    const detectedDataloggers = await autoDetectDataloggers();
    
    if (detectedDataloggers.length === 0) {
      console.log("\nNo dataloggers detected automatically.");
      console.log("Falling back to manual port selection...");
      
      // Fallback to manual selection
      const result = await promptForSerialPort();
      return await createConfigFromManualSelection(result);
    }
    
    // Handle detected dataloggers
    return await handleDetectedDataloggers(detectedDataloggers);
    
  } catch (error: any) {
    console.error(`Setup failed: ${error.message}`);
    throw error;
  }
}

/**
 * Creates configuration from manual port selection (fallback)
 */
async function createConfigFromManualSelection(result: {
  path: string;
  channels: { hex: string; number: number; temperature: number }[];
}): Promise<AppConfig> {
  const datalogger = createDefaultDataloggerConfig(1, result.path, result.channels);
  // Override autoDetected flag for manual selection
  datalogger.autoDetected = false;

  const config: AppConfig = {
    dataloggers: [datalogger],
    globalSettings: {
      connectionTimeout: 60,
      defaultThermocoupleType: "K"
    }
  };

  await saveAndDisplayConfig(config, [result]);
  return config;
}

/**
 * Handles multiple detected dataloggers and user selection
 */
async function handleDetectedDataloggers(detectedDataloggers: {
  path: string;
  channels: { hex: string; number: number; temperature: number }[];
  score: number;
  reason: string;
}[]): Promise<AppConfig> {
  
  console.log(`\nFound ${detectedDataloggers.length} datalogger(s):`);
  detectedDataloggers.forEach((dl, index) => {
    console.log(`  - Datalogger ${index + 1}: ${dl.channels.length} thermocouples @ ${pc.cyan(dl.path)}`);
  });
  return await createConfigFromDetectedDataloggers(detectedDataloggers);
}

/**
 * Creates configuration from detected dataloggers
 */
async function createConfigFromDetectedDataloggers(dataloggers: {
  path: string;
  channels: { hex: string; number: number; temperature: number }[];
  score: number;
  reason: string;
}[]): Promise<AppConfig> {
  
  const configDataloggers: DataloggerConfig[] = dataloggers.map((dl, index) =>
    createDefaultDataloggerConfig(index + 1, dl.path, dl.channels)
  );

  const config: AppConfig = {
    dataloggers: configDataloggers,
    globalSettings: {
      connectionTimeout: 60,
      defaultThermocoupleType: "K"
    }
  };

  await saveAndDisplayConfig(config, dataloggers);
  return config;
}

/**
 * Saves configuration and displays setup results
 */
async function saveAndDisplayConfig(config: AppConfig, results: {
  path: string;
  channels: { hex: string; number: number; temperature: number }[];
}[]): Promise<void> {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`\nConfiguration saved to ${pc.cyan('./config.json')}`);

  // Display results for each datalogger
  config.dataloggers.forEach((datalogger, index) => {
    const result = results[index];
    if (result && result.channels.length > 0) {
      console.log(`\n${datalogger.name} (${pc.cyan(datalogger.serial.path)}):`);
      console.log(`${pc.green(result.channels.length)} active channels:`);
      result.channels.forEach((channel) => {
        console.log(
          `  - Channel ${channel.number}: ${channel.temperature}°C`
        );
      });
    } else {
      console.log(`\n${datalogger.name} (${pc.cyan(datalogger.serial.path)}): No active channels detected`);
      console.log("Channels will be auto-detected when monitoring starts");
    }
  });

  console.log("\nNext Steps:");
  console.log("1. Run 'npm start' to begin monitoring");
  console.log("2. Active channels will be automatically detected and displayed");
  console.log("\nTip: You can customize datalogger and channel names by editing config.json");
}

// Run setup when this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  setupConfig()
    .then(() => {
      console.log("Setup complete!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Setup failed:", error.message);
      process.exit(1);
    });
}
