import { existsSync, writeFileSync, readFileSync } from "fs";
import { SerialPort } from "serialport";
import * as readline from "readline";
import * as os from "os";
import { processSerialBuffer } from "./parser";

/**
 * Configuration interface for serial port connection
 */
export interface SerialConfig {
  /** Serial port path (e.g., '/dev/tty.usbserial-AB0N89MV' or 'COM3') */
  path: string;
  /** Baud rate for serial communication */
  baudRate: number;
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
 * Main application configuration interface
 */
export interface AppConfig {
  /** Serial port configuration */
  serial: SerialConfig;
  /** Array of configured thermocouple channels */
  thermocouples: ThermocoupleConfig[];
}

/** Path to the configuration file */
const CONFIG_PATH = "./config.json";

// Channel validation constants imported from shared parser

/**
 * Tests a serial port for valid HH-4208SD thermocouple data
 * Attempts to read data for up to 10 seconds and validates the format
 * @param portPath - The serial port path to test
 * @returns Promise resolving to the port path if valid data detected
 * @throws Error with specific guidance if no valid data found
 */
async function testPortForData(portPath: string): Promise<string> {
  console.log(`\n[config] Testing ${portPath} for valid thermocouple data...`);
  console.log("[config] Looking for HH-4208SD data format (up to 10 seconds)...");
  
  return new Promise((resolve, reject) => {
    let port: SerialPort;
    let buffer = "";
    let dataReceived = false;
    let timeout: NodeJS.Timeout;
    
    // Set up timeout for data detection
    timeout = setTimeout(() => {
      cleanup();
      if (!dataReceived) {
        reject(new Error(
          `No data received from ${portPath}\n\n` +
          `Please check your HH-4208SD configuration:\n` +
          `1. Set sampling rate to "1" (1 second intervals)\n` +
          `2. Set USB cable switch to position "2" (photo mode)\n` +
          `3. Ensure data logging is enabled on the device\n` +
          `4. Verify thermocouple connections\n\n` +
          `The device should be continuously outputting temperature data.`
        ));
      } else {
        reject(new Error(
          `Data received from ${portPath} but format is not recognized as HH-4208SD\n\n` +
          `Please verify:\n` +
          `1. USB cable switch is set to position "2" (photo mode)\n` +
          `2. Device is HH-4208SD thermocouple data logger\n` +
          `3. Sampling rate is set to "1" second\n\n` +
          `Expected format: STX + 2-digit hex channel + sensor data`
        ));
      }
    }, 10000); // 10 second timeout
    
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
        
        // Check for any valid messages
        for (const parsed of result.messages) {
          if (parsed.valid && parsed.channelHex && parsed.channelNumber) {
            cleanup();
            console.log(`[config] ✓ Valid HH-4208SD data detected on ${portPath}`);
            console.log(`[config] Found active channel: ${parsed.channelHex} (Channel ${parsed.channelNumber})`);
            console.log(`[config] Temperature: ${parsed.temperature}°${parsed.temperatureUnit}`);
            resolve(portPath);
            return;
          }
        }
      });
      
      port.on("error", (err: Error) => {
        cleanup();
        reject(new Error(`Cannot open ${portPath}: ${err.message}`));
      });
      
      port.on("open", () => {
        console.log(`[config] Port ${portPath} opened, listening for data...`);
      });
      
    } catch (error: any) {
      cleanup();
      reject(new Error(`Failed to test ${portPath}: ${error.message}`));
    }
  });
}

/**
 * Validates the configuration object structure and values
 * @param config - The configuration object to validate
 * @throws {Error} If the configuration is invalid
 */
function validateConfig(config: any): asserts config is AppConfig {
  if (!config || !Array.isArray(config.thermocouples)) {
    throw new Error("Config must have a 'thermocouples' array");
  }
  if (
    !config.serial ||
    typeof config.serial.path !== "string" ||
    typeof config.serial.baudRate !== "number"
  ) {
    throw new Error(
      "Config must have a valid 'serial' configuration with 'path' and 'baudRate'"
    );
  }
  for (const tc of config.thermocouples) {
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
}


/**
 * Lists available serial ports using SerialPort.list() and prompts user to select one
 * @returns Promise resolving to the selected serial port path
 */
async function promptForSerialPort(): Promise<string> {
  console.log("\n[config] Scanning for available serial ports...");

  try {
    // Use SerialPort.list() to get port information
    const ports = await SerialPort.list();
    
    // Filter out system ports that are unlikely to be the thermocouple logger
    const filteredPorts = ports.filter(port => {
      const path = port.path.toLowerCase();
      const platform = os.platform();
      
      if (platform === 'darwin') {
        // On macOS, filter out built-in ports and focus on USB devices
        return path.includes('usbserial') || path.includes('usbmodem') || 
               (port.manufacturer && !path.includes('bluetooth') && !path.includes('debug'));
      } else if (platform === 'win32') {
        // On Windows, look for COM ports
        return path.startsWith('com');
      } else {
        // On Linux, look for USB and ACM devices
        return path.includes('usb') || path.includes('acm') || path.includes('ttyusb');
      }
    });

    const portsToShow = filteredPorts.length > 0 ? filteredPorts : ports;

    if (portsToShow.length === 0) {
      throw new Error(
        "No serial ports found. Please connect your HH-4208SD thermocouple logger and try again."
      );
    }

    console.log("\n[config] Available serial ports:");
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
      } else if (manufacturer && manufacturer.toLowerCase().includes('ftdi')) {
        deviceHint = " [FTDI - Compatible with HH-4208SD]";
      }
      
      console.log(
        `  ${index + 1}. ${port.path} (${manufacturer}, VID:${vendorId}, PID:${productId}${serialNumber})${deviceHint}`
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
          `\n[config] Auto-select the only available port "${portsToShow[0].path}"? (Y/n): `,
          (answer: string) => {
            rl.close();
            resolve(answer.trim().toLowerCase() !== 'n');
          }
        );
      });

      if (autoSelect) {
        console.log(`[config] Selected: ${portsToShow[0].path}`);
        // Test the auto-selected port for valid HH-4208SD data
        try {
          const validatedPath = await testPortForData(portsToShow[0].path);
          return validatedPath;
        } catch (error: any) {
          console.error(`[config] Data validation failed: ${error.message}`);
          // Ask user if they want to continue anyway
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          
          const continueAnyway = await new Promise<boolean>((resolve) => {
            rl.question(
              `\n[config] Continue with ${portsToShow[0].path} anyway? (y/N): `,
              (answer: string) => {
                rl.close();
                resolve(answer.trim().toLowerCase() === 'y');
              }
            );
          });
          
          if (continueAnyway) {
            console.log(`[config] Continuing with ${portsToShow[0].path} - data validation can be done later`);
            return portsToShow[0].path;
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
        `\n[config] Please select a serial port (1-${portsToShow.length}): `,
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
    console.log(`\n[config] Selected: ${selectedPort.path}`);
    if (selectedPort.manufacturer) {
      console.log(`[config] Device: ${selectedPort.manufacturer}`);
    }

    // Test the selected port for valid HH-4208SD data
    try {
      const validatedPath = await testPortForData(selectedPort.path);
      return validatedPath;
    } catch (error: any) {
      console.error(`[config] Data validation failed: ${error.message}`);
      // Ask user if they want to continue anyway
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      
      const continueAnyway = await new Promise<boolean>((resolve) => {
        rl.question(
          `\n[config] Continue with ${selectedPort.path} anyway? (y/N): `,
          (answer: string) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === 'y');
          }
        );
      });
      
      if (continueAnyway) {
        console.log(`[config] Continuing with ${selectedPort.path} - data validation can be done later`);
        return selectedPort.path;
      } else {
        throw new Error("Setup cancelled by user");
      }
    }
  } catch (error: any) {
    console.error(`[config] Error listing serial ports: ${error.message}`);
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
    serial: {
      path: "/dev/tty.usbserial", // Default path (likely to fail, will trigger serial error)
      baudRate: 9600,
    },
    thermocouples: [], // Empty - will use pure auto-detection
  };

  if (!existsSync(CONFIG_PATH)) {
    console.log(
      `[config] No config.json found - running in auto-detection mode`
    );
    console.log(
      `[config] Channels will be automatically detected from incoming data`
    );
    console.log(
      `[config] Run 'npm run setup' to configure serial port and customize channel names`
    );
    return defaultConfig;
  }

  try {
    const text = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(text);
    validateConfig(config);
    return config;
  } catch (err: any) {
    console.warn(
      `[config] config.json is invalid: ${err.message || err}`
    );
    console.log(
      `[config] Falling back to auto-detection mode`
    );
    console.log(
      `[config] Fix config.json or delete it and run 'npm run setup' to reconfigure`
    );
    return defaultConfig;
  }
}

/**
 * Setup command to generate configuration interactively
 * Focuses on serial port configuration - channels will be auto-detected
 * @returns Promise resolving to the generated configuration
 */
export async function setupConfig(): Promise<AppConfig> {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║                  HH-4208SD Thermocouple Logger Setup         ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("\n[config] This setup will configure your serial port connection.");
  console.log("[config] Thermocouple channels will be automatically detected when you start logging.");
  console.log("\n[config] IMPORTANT - HH-4208SD Device Configuration:");
  console.log("[config] 1. Set sampling rate to '1' (1 second intervals)");
  console.log("[config] 2. Set USB cable switch to position '2' (photo mode)");
  console.log("[config] 3. Ensure data logging is enabled on the device");
  console.log("[config] 4. Connect thermocouples to desired channels\n");

  const serialPath = await promptForSerialPort();

  // Create minimal config with just serial port - no pre-configured channels
  const config: AppConfig = {
    serial: {
      path: serialPath,
      baudRate: 9600,
    },
    thermocouples: [], // Empty - channels will be auto-detected
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`\n[config] Configuration saved to ${CONFIG_PATH}`);
  console.log("[config] ✓ Serial port configured successfully!");
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║                           Next Steps                        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("[config] 1. Verify HH-4208SD settings:");
  console.log("[config]    • Sampling rate: '1' second");
  console.log("[config]    • USB cable switch: position '2' (photo mode)");
  console.log("[config]    • Data logging: enabled");
  console.log("[config] 2. Connect thermocouples to desired channels");
  console.log("[config] 3. Run 'npm start' to begin monitoring");
  console.log("[config] 4. Active channels will be automatically detected and displayed");
  console.log("\n[config] 💡 Tip: You can customize channel names later by editing config.json");
  console.log("[config] 🔧 Troubleshooting: If no data appears, verify the HH-4208SD settings above");
  
  return config;
}

// Run setup when this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  setupConfig().then(() => {
    console.log('Setup complete!');
    process.exit(0);
  }).catch((error) => {
    console.error('Setup failed:', error.message);
    process.exit(1);
  });
}
