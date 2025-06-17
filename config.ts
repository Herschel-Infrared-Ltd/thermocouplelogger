import { existsSync, writeFileSync, readFileSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Add readline for user input
const readline = require("readline");

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
 * Interface for serial port information from @serialport/list
 */
interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  locationId?: string;
  vendorId?: string;
  productId?: string;
}

/**
 * Lists available serial ports using @serialport/list package and prompts user to select one
 * @returns Promise resolving to the selected serial port path
 */
async function promptForSerialPort(): Promise<string> {
  console.log("\n[config] Scanning for available serial ports...");

  try {
    // Use @serialport/list to get port information in JSON format
    const { stdout } = await execAsync("npx @serialport/list -f json");
    const ports: SerialPortInfo[] = JSON.parse(stdout.trim());

    if (ports.length === 0) {
      throw new Error(
        "No serial ports found. Please connect your HH-4208SD thermocouple logger and try again."
      );
    }

    console.log("\n[config] Available serial ports:");
    ports.forEach((port, index) => {
      const manufacturer = port.manufacturer || "Unknown";
      const productId = port.productId || "N/A";
      const vendorId = port.vendorId || "N/A";
      const serialNumber = port.serialNumber ? ` SN:${port.serialNumber}` : "";
      console.log(
        `  ${index + 1}. ${
          port.path
        } (${manufacturer}, VID:${vendorId}, PID:${productId}${serialNumber})`
      );
    });

    // Create readline interface for user input
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Prompt user to select a port
    const selectedIndex = await new Promise<number>((resolve) => {
      rl.question(
        `\n[config] Please select a serial port (1-${ports.length}): `,
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
      selectedIndex >= ports.length ||
      isNaN(selectedIndex)
    ) {
      throw new Error(
        "Invalid selection. Please restart and select a valid port number."
      );
    }

    const selectedPort = ports[selectedIndex];
    console.log(`\n[config] Selected: ${selectedPort.path}`);
    if (selectedPort.manufacturer) {
      console.log(`[config] Device: ${selectedPort.manufacturer}`);
      if (selectedPort.vendorId === "0403") {
        console.log(
          "[config] FTDI device detected - compatible with HH-4208SD thermocouple logger"
        );
      }
    }

    return selectedPort.path;
  } catch (error: any) {
    console.error(`[config] Error listing serial ports: ${error.message}`);
    throw new Error(
      "Failed to detect serial ports. Please check your device connection and try again."
    );
  }
}

/**
 * Loads the application configuration from the config.json file
 * If the file doesn't exist, generates a default configuration and exits the process
 * @returns The loaded configuration (now synchronous)
 * @throws {Error} If the configuration file is invalid or cannot be parsed
 */
export function loadConfig(): AppConfig {
  if (!existsSync(CONFIG_PATH)) {
    console.error(
      `\n[config] config.json was not found. Please run 'npm run setup' to generate a default config, then restart the server. Exiting.\n`
    );
    process.exit(1);
  }
  const text = readFileSync(CONFIG_PATH, "utf-8");
  let config;
  try {
    config = JSON.parse(text);
    validateConfig(config);
  } catch (err: any) {
    console.error(
      `\n[config] config.json is invalid: ${
        err.message || err
      }\nPlease fix or delete config.json and restart. Exiting.\n`
    );
    process.exit(1);
  }
  return config;
}

/**
 * Setup command to generate configuration interactively
 * @returns Promise resolving to the generated configuration
 */
export async function setupConfig(): Promise<AppConfig> {
  const serialPath = await promptForSerialPort();

  const thermocouples: ThermocoupleConfig[] = [];
  // Generate default config for all 12 channels
  for (let i = 1; i <= 12; i++) {
    thermocouples.push({
      name: `thermocouple_${i}`,
      type: "K",
      channel: i,
    });
  }

  const config: AppConfig = {
    serial: {
      path: serialPath,
      baudRate: 9600,
    },
    thermocouples,
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`\n[config] Configuration saved to ${CONFIG_PATH}`);
  return config;
}
