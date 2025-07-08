/**
 * CLI-based SerialPort implementation for cross-platform compatibility
 * 
 * This module provides a serial port implementation that leverages system CLI tools
 * to avoid native dependencies while maintaining Web Serial API compatibility.
 * This approach trades some efficiency for better portability and easier deployment.
 * 
 * Key features:
 * - CLI-based approach using system utilities (cu, stty, cat on Unix; PowerShell on Windows)
 * - No native dependencies required
 * - Automatic reconnection with exponential backoff
 * - Health monitoring and connection status tracking
 * - Web Serial API compatible interface
 * - Cross-platform support (macOS, Linux, Windows)
 * - Production-ready error handling and recovery
 * 
 * @author Thermocouple Logger
 * @version 1.0.0
 * @since 1.0.0
 */

import { execSync, spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { existsSync } from "fs";
import * as os from "os";

/**
 * Parity types supported by serial ports
 * @typedef {"none" | "even" | "odd"} ParityType
 */
export type ParityType = "none" | "even" | "odd";

/**
 * Flow control types for serial communication
 * @typedef {"none" | "hardware"} FlowControlType
 */
export type FlowControlType = "none" | "hardware";

/**
 * Configuration options for serial port communication
 * 
 * @interface SerialOptions
 * @property {number} baudRate - Communication speed in bits per second (required)
 * @property {number} [dataBits=8] - Number of data bits per frame (5-8)
 * @property {number} [stopBits=1] - Number of stop bits (1 or 2)
 * @property {ParityType} [parity="none"] - Parity checking type
 * @property {number} [bufferSize=1024] - Buffer size for read/write operations
 * @property {FlowControlType} [flowControl="none"] - Flow control mechanism
 */
export interface SerialOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: ParityType;
  bufferSize?: number;
  flowControl?: FlowControlType;
}

/**
 * Information about a serial port device
 * 
 * @interface SerialPortInfo
 * @property {number} [usbVendorId] - USB vendor identifier
 * @property {number} [usbProductId] - USB product identifier
 * @property {string} [path] - Device path (e.g., /dev/ttyUSB0, COM3)
 * @property {string} [manufacturer] - Device manufacturer name
 * @property {string} [vendorId] - Vendor identifier string
 * @property {string} [productId] - Product identifier string
 * @property {string} [serialNumber] - Device serial number
 * @property {boolean} [isHealthy] - Runtime health status
 * @property {number} [lastDataTime] - Timestamp of last data received
 * @property {number} [reconnectAttempts] - Number of reconnection attempts
 */
export interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
  path?: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
  // Runtime information (optional)
  isHealthy?: boolean;
  lastDataTime?: number;
  reconnectAttempts?: number;
}

/**
 * Serial port control signals for device communication
 * 
 * @interface SerialOutputSignals
 * @property {boolean} [dataTerminalReady] - DTR signal state (Data Terminal Ready)
 * @property {boolean} [requestToSend] - RTS signal state (Request To Send)
 * @property {boolean} [break] - Break signal state
 */
export interface SerialOutputSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
  break?: boolean;
}

/**
 * Options for requesting access to serial ports
 * 
 * @interface SerialPortRequestOptions
 * @property {SerialPortFilter[]} [filters] - Array of filters to match desired ports
 */
export interface SerialPortRequestOptions {
  filters?: SerialPortFilter[];
}

/**
 * Filter criteria for selecting serial ports
 * 
 * @interface SerialPortFilter
 * @property {number} [usbVendorId] - Filter by USB vendor ID
 * @property {number} [usbProductId] - Filter by USB product ID
 */
export interface SerialPortFilter {
  usbVendorId?: number;
  usbProductId?: number;
}

/**
 * Platform-specific command configuration
 * 
 * @interface PlatformCommand
 * @property {string[]} list - Command to list available serial ports
 * @property {Function} connect - Function that returns connection command args
 * @property {Function} [configure] - Optional function for port configuration
 */
interface PlatformCommand {
  list: string[];
  connect: (port: string, baud: number, options: SerialOptions) => string[];
  configure?: (port: string, options: SerialOptions) => string[];
}

/**
 * CLI-based SerialPort class with production-ready reliability features
 * 
 * This class provides a serial port implementation using CLI-based system utilities
 * to avoid native dependencies. It maintains Web Serial API compatibility
 * while offering features like automatic reconnection, health monitoring,
 * and cross-platform support.
 * 
 * Implementation approach:
 * - Uses system CLI utilities instead of native bindings
 * - Avoids compilation and native dependency issues
 * - Leverages mature, battle-tested system tools
 * 
 * Reliability features:
 * - Automatic reconnection with exponential backoff
 * - Connection health monitoring with 60-second timeout detection
 * - Buffered writes with flow control
 * - Enhanced error classification and recovery
 * - Platform-specific optimizations
 * 
 * @class SerialPort
 * @extends EventEmitter
 * 
 * @fires SerialPort#open - Emitted when port connection is established
 * @fires SerialPort#close - Emitted when port connection is closed
 * @fires SerialPort#error - Emitted when an error occurs
 * @fires SerialPort#data - Emitted when data is received from the port
 * @fires SerialPort#healthchange - Emitted when connection health status changes
 * 
 * @example
 * ```typescript
 * const port = new SerialPort({ path: '/dev/ttyUSB0', baudRate: 9600 });
 * 
 * port.on('open', () => {
 *   console.log('Port opened successfully');
 * });
 * 
 * port.on('data', (data) => {
 *   console.log('Received:', data.toString());
 * });
 * 
 * await port.open({ baudRate: 115200 });
 * ```
 */
export class SerialPort extends EventEmitter {
  private process: ChildProcess | null = null;
  private platform: string;
  private isConnected: boolean = false;
  private readable_: ReadableStream<Uint8Array> | null = null;
  private writable_: WritableStream<Uint8Array> | null = null;
  private serialOptions_: SerialOptions;
  private portInfo_: SerialPortInfo;

  // Enhanced reliability features
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 1000;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private writeBuffer: Array<{
    data: Buffer;
    resolve: Function;
    reject: Function;
  }> = [];
  private processingBuffer: boolean = false;
  private maxBufferSize: number = 1000;
  private lastDataTime: number = 0;
  private connectionHealthy: boolean = true;

  public path: string;
  public baudRate: number;

  private static platformCommands: Record<string, PlatformCommand> = {
    darwin: {
      list: ["ls", "/dev/cu.*"],
      connect: (port, baud, options) => {
        // Try direct stty + cat approach first
        try {
          execSync(
            `stty -f ${port} ${baud} raw -echo -cstopb -parenb cs${
              options.dataBits || 8
            }`,
            { stdio: "pipe" }
          );
          return ["cat", port];
        } catch {
          // Fallback to cu
          return ["cu", "-l", port, "-s", baud.toString()];
        }
      },
      configure: (port, options) => [
        "stty",
        "-f",
        port,
        options.baudRate.toString(),
        "raw",
        "-echo",
        "-cstopb",
        "-parenb",
        `cs${options.dataBits || 8}`,
      ],
    },
    linux: {
      list: ["sh", "-c", "ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true"],
      connect: (port, baud, options) => {
        execSync(
          `stty -F ${port} ${baud} raw -echo -echoe -echok -cstopb -parenb cs${
            options.dataBits || 8
          }`,
          { stdio: "inherit" }
        );
        return ["cat", port];
      },
      configure: (port, options) => [
        "stty",
        "-F",
        port,
        options.baudRate.toString(),
        "raw",
        "-echo",
        "-echoe",
        "-echok",
        "-cstopb",
        "-parenb",
        `cs${options.dataBits || 8}`,
      ],
    },
    win32: {
      list: [
        "powershell",
        "-Command",
        "[System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object { Write-Output $_ }",
      ],
      connect: (port, baud, options) => {
        const dataBits = options.dataBits || 8;
        const stopBits = options.stopBits === 2 ? "Two" : "One";
        const parity =
          options.parity === "even"
            ? "Even"
            : options.parity === "odd"
            ? "Odd"
            : "None";

        const psScript = `
          $ErrorActionPreference = 'Stop'
          try {
            $port = New-Object System.IO.Ports.SerialPort '${port}',${baud},'${parity}',${dataBits},'${stopBits}'
            $port.ReadTimeout = 1000
            $port.WriteTimeout = 1000
            $port.Open()
            
            while($port.IsOpen) {
              try {
                if($port.BytesToRead -gt 0) {
                  $data = $port.ReadExisting()
                  Write-Output $data
                }
                Start-Sleep -Milliseconds 10
              } catch {
                if($port.IsOpen) { $port.Close() }
                break
              }
            }
          } catch {
            Write-Error "Failed to open port: $_"
            exit 1
          }
        `;
        return ["powershell", "-Command", psScript];
      },
    },
  };

  /**
   * Creates a new SerialPort instance
   * 
   * @param {Object|SerialPortInfo} options - Port configuration options
   * @param {string} options.path - Device path (e.g., '/dev/ttyUSB0', 'COM3')
   * @param {number} [options.baudRate=9600] - Communication speed in baud
   * 
   * @example
   * ```typescript
   * // Simple path and baud rate
   * const port = new SerialPort({ path: '/dev/ttyUSB0', baudRate: 115200 });
   * 
   * // Using SerialPortInfo object
   * const portInfo = await SerialPort.list()[0];
   * const port = new SerialPort(portInfo);
   * ```
   */
  constructor(options: { path: string; baudRate?: number } | SerialPortInfo) {
    super();

    if (
      "baudRate" in options ||
      (typeof options.path === "string" && !("manufacturer" in options))
    ) {
      const pathOptions = options as { path: string; baudRate?: number };
      this.path = pathOptions.path;
      this.baudRate = pathOptions.baudRate || 9600;
      this.portInfo_ = { path: this.path };
    } else {
      const portInfo = options as SerialPortInfo;
      this.path = portInfo.path || "";
      this.baudRate = 9600;
      this.portInfo_ = portInfo;
    }

    this.platform = os.platform();
    this.serialOptions_ = {
      baudRate: this.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      bufferSize: 1024, // Increased from 255
      flowControl: "none",
    };

    // Set up health monitoring
    this.setupHealthMonitoring();
  }

  /**
   * Lists all available serial ports on the system
   * 
   * Uses platform-specific commands to enumerate serial devices:
   * - macOS: Lists /dev/cu.* devices (callout ports)
   * - Linux: Lists /dev/ttyUSB* and /dev/ttyACM* devices
   * - Windows: Uses PowerShell to query WMI for serial ports
   * 
   * @static
   * @returns {Promise<SerialPortInfo[]>} Array of available serial port information
   * 
   * @example
   * ```typescript
   * const ports = await SerialPort.list();
   * console.log('Available ports:', ports);
   * 
   * // Find Arduino devices
   * const arduinoPorts = ports.filter(p => 
   *   p.manufacturer?.includes('Arduino') ||
   *   p.path?.includes('usbmodem')
   * );
   * ```
   */
  static async list(): Promise<SerialPortInfo[]> {
    const platform = os.platform();
    const ports: SerialPortInfo[] = [];
    const commands = SerialPort.platformCommands[platform];

    if (!commands) {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    try {
      let result: string;
      if (platform === "darwin") {
        // Use glob pattern for macOS
        result = execSync("ls /dev/cu.* 2>/dev/null || true", {
          encoding: "utf8" as const,
          timeout: 5000,
          shell: "/bin/sh",
        });
      } else {
        result = execSync(commands.list.join(" "), {
          encoding: "utf8",
          timeout: 5000,
        });
      }

      const portPaths = result
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .filter((line) => line.startsWith("/dev/")); // Only include device paths

      for (const path of portPaths) {
        const portInfo: SerialPortInfo = { path };

        // Enhanced device detection for macOS and Linux
        if (platform !== "win32") {
          try {
            // Try to get device info from system
            if (path.includes("usbserial") || path.includes("usbmodem")) {
              portInfo.manufacturer = "USB Serial Device";
            } else if (path.includes("Bluetooth")) {
              portInfo.manufacturer = "Bluetooth";
            } else if (path.includes("debug")) {
              portInfo.manufacturer = "Debug Console";
            } else {
              portInfo.manufacturer = "Unknown";
            }
          } catch {
            portInfo.manufacturer = "Unknown";
          }
        } else {
          // Windows - get more detailed info
          try {
            const winInfoCmd = `Get-WmiObject -Class Win32_SerialPort | Where-Object {$_.DeviceID -eq '${path}'} | Select-Object Name, Manufacturer, DeviceID | ConvertTo-Json`;
            const infoResult = execSync(`powershell -Command "${winInfoCmd}"`, {
              encoding: "utf8",
              timeout: 3000,
            });
            const info = JSON.parse(infoResult);
            if (info) {
              portInfo.manufacturer = info.Manufacturer || "Unknown";
            }
          } catch {
            portInfo.manufacturer = "Unknown";
          }
        }

        ports.push(portInfo);
      }
    } catch (error) {
      console.warn("Failed to list serial ports:", error);
    }

    return ports;
  }

  /**
   * Gets the readable stream for receiving data from the serial port
   * 
   * Creates a Web Streams API compatible ReadableStream that emits Uint8Array chunks
   * as data arrives from the serial device. The stream includes enhanced error handling
   * and automatic recovery for non-fatal errors.
   * 
   * @readonly
   * @returns {ReadableStream<Uint8Array>|null} Readable stream or null if port not open
   * 
   * @example
   * ```typescript
   * const reader = port.readable?.getReader();
   * if (reader) {
   *   while (true) {
   *     const { value, done } = await reader.read();
   *     if (done) break;
   *     console.log('Received:', new TextDecoder().decode(value));
   *   }
   * }
   * ```
   */
  get readable(): ReadableStream<Uint8Array> | null {
    if (!this.readable_ && this.isConnected) {
      this.readable_ = new ReadableStream<Uint8Array>(
        {
          start: (controller) => {
            const onData = (data: Buffer) => {
              try {
                this.lastDataTime = Date.now();
                this.connectionHealthy = true;
                const chunk = new Uint8Array(
                  data.buffer,
                  data.byteOffset,
                  data.byteLength
                );
                controller.enqueue(chunk);
              } catch (error) {
                // Ignore errors if controller is closed
              }
            };

            const onError = (error: Error) => {
              try {
                this.connectionHealthy = false;
                controller.error(error);
              } catch {
                // Ignore errors if controller is closed
              }
            };

            const onClose = () => {
              try {
                controller.close();
              } catch {
                // Ignore errors if controller is already closed
              }
            };

            this.on("data", onData);
            this.on("error", onError);
            this.on("close", onClose);

            // Store cleanup function
            (controller as any)._cleanup = () => {
              this.off("data", onData);
              this.off("error", onError);
              this.off("close", onClose);
            };
          },
          cancel: () => {
            if ((this.readable_ as any)._cleanup) {
              (this.readable_ as any)._cleanup();
            }
            this.readable_ = null;
          },
        },
        {
          highWaterMark: this.serialOptions_.bufferSize,
        }
      );
    }
    return this.readable_;
  }

  /**
   * Gets the writable stream for sending data to the serial port
   * 
   * Creates a Web Streams API compatible WritableStream that accepts Uint8Array chunks
   * and sends them to the serial device. Includes buffering and flow control to prevent
   * overwhelming the port.
   * 
   * @readonly
   * @returns {WritableStream<Uint8Array>|null} Writable stream or null if port not open
   * 
   * @example
   * ```typescript
   * const writer = port.writable?.getWriter();
   * if (writer) {
   *   const encoder = new TextEncoder();
   *   await writer.write(encoder.encode('Hello, device!\n'));
   *   writer.releaseLock();
   * }
   * ```
   */
  get writable(): WritableStream<Uint8Array> | null {
    if (!this.writable_ && this.isConnected) {
      this.writable_ = new WritableStream<Uint8Array>({
        write: async (chunk) => {
          if (!this.isConnected) {
            throw new Error("Port not open");
          }

          const buffer = Buffer.from(
            chunk.buffer,
            chunk.byteOffset,
            chunk.byteLength
          );
          await this.writeBuffered(buffer);
        },
        close: () => {
          this.writable_ = null;
        },
        abort: () => {
          this.writable_ = null;
          this.clearWriteBuffer();
        },
      });
    }
    return this.writable_;
  }

  /**
   * Checks if the serial port is available for use
   * 
   * Performs platform-specific checks to determine if the port is locked
   * or being used by another process.
   * 
   * @private
   * @returns {Promise<boolean>} True if port is available, false otherwise
   */
  private async isPortAvailable(): Promise<boolean> {
    if (this.platform === "darwin") {
      try {
        const lockFile = `/var/spool/uucp/LCK..${this.path.split("/").pop()}`;
        return !existsSync(lockFile);
      } catch {
        return true;
      }
    }

    // For other platforms, try a quick test
    try {
      const testProcess = spawn("test", ["-c", this.path], { stdio: "ignore" });
      return new Promise((resolve) => {
        testProcess.on("close", (code) => resolve(code === 0));
        setTimeout(() => {
          testProcess.kill();
          resolve(false);
        }, 1000);
      });
    } catch {
      return true; // Assume available if we can't test
    }
  }

  /**
   * Opens the serial port connection with automatic retry logic
   * 
   * Establishes a connection to the serial device using platform-specific utilities.
   * Includes automatic retry with exponential backoff for transient failures.
   * 
   * @param {SerialOptions} [options] - Optional serial port configuration
   * @throws {Error} When port is already open or connection fails permanently
   * 
   * @example
   * ```typescript
   * // Open with default settings
   * await port.open();
   * 
   * // Open with custom configuration
   * await port.open({
   *   baudRate: 115200,
   *   dataBits: 8,
   *   stopBits: 1,
   *   parity: 'none'
   * });
   * ```
   */
  async open(options?: SerialOptions): Promise<void> {
    if (options) {
      this.serialOptions_ = { ...this.serialOptions_, ...options };
      this.baudRate = this.serialOptions_.baudRate;
    }

    if (this.isConnected) {
      throw new Error("Port already open");
    }

    const available = await this.isPortAvailable();
    if (!available) {
      throw new Error(`Serial port ${this.path} is locked or unavailable`);
    }

    return this.connectWithRetry();
  }

  /**
   * Establishes connection with automatic retry logic and exponential backoff
   * 
   * @private
   * @returns {Promise<void>} Resolves when connection is established
   */
  private async connectWithRetry(): Promise<void> {
    return new Promise((resolve, reject) => {
      const attemptConnection = () => {
        const onOpen = () => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.connectionHealthy = true;
          this.lastDataTime = Date.now();
          this.off("error", onError);
          resolve();
        };

        const onError = (error: Error) => {
          this.off("open", onOpen);

          if (this.shouldReconnect(error)) {
            this.scheduleReconnect().then(attemptConnection).catch(reject);
          } else {
            reject(error);
          }
        };

        this.once("open", onOpen);
        this.once("error", onError);

        this.openPort();
      };

      attemptConnection();
    });
  }

  /**
   * Determines if an automatic reconnection attempt should be made
   * 
   * @private
   * @param {Error} error - The error that caused the connection failure
   * @returns {boolean} True if reconnection should be attempted
   */
  private shouldReconnect(error: Error): boolean {
    return (
      this.reconnectAttempts < this.maxReconnectAttempts &&
      (error.message.includes("cannot open") ||
        error.message.includes("disconnected") ||
        error.message.includes("Device or resource busy"))
    );
  }

  /**
   * Schedules a reconnection attempt with exponential backoff
   * 
   * Implements exponential backoff with a maximum delay of 30 seconds
   * to avoid overwhelming the system or device.
   * 
   * @private
   * @returns {Promise<void>} Resolves after the delay period
   */
  private async scheduleReconnect(): Promise<void> {
    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      30000 // Max 30 seconds
    );

    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  /**
   * Opens the serial port using platform-specific CLI utilities
   * 
   * Uses optimized commands for each platform:
   * - macOS: stty + cat or cu fallback
   * - Linux: stty + cat with enhanced options
   * - Windows: PowerShell with .NET SerialPort class
   * 
   * @private
   * @fires SerialPort#open
   * @fires SerialPort#error
   */
  private openPort(): void {
    try {
      const commands = SerialPort.platformCommands[this.platform];
      if (!commands) {
        throw new Error(`Unsupported platform: ${this.platform}`);
      }

      const commandArgs = commands.connect(
        this.path,
        this.baudRate,
        this.serialOptions_
      );
      this.process = spawn(commandArgs[0], commandArgs.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (this.process) {
        this.setupProcessHandlers();

        // Delayed open event to ensure process is ready
        setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.emit("open");
          }
        }, 100);
      }
    } catch (error) {
      this.emit("error", error);
    }
  }

  /**
   * Sets up event handlers for the spawned process with enhanced error detection
   * 
   * Provides intelligent error classification and appropriate error messages
   * for common serial port issues like permission denied, device busy, etc.
   * 
   * @private
   * @fires SerialPort#data
   * @fires SerialPort#error
   * @fires SerialPort#close
   */
  private setupProcessHandlers(): void {
    if (!this.process) return;

    this.process.stdout?.on("data", (data) => {
      this.emit("data", data);
    });

    this.process.stderr?.on("data", (data) => {
      const errorMessage = data.toString().trim();

      // Enhanced error classification
      if (
        errorMessage.includes("Permission denied") ||
        errorMessage.includes("Operation not permitted")
      ) {
        this.emit(
          "error",
          new Error(
            `Permission denied accessing ${this.path}. Try running with appropriate permissions.`
          )
        );
      } else if (
        errorMessage.includes("Line in use") ||
        errorMessage.includes("Device or resource busy")
      ) {
        this.emit(
          "error",
          new Error(
            `Serial port ${this.path} is already in use by another process`
          )
        );
      } else if (
        errorMessage.includes("No such file or directory") ||
        errorMessage.includes("cannot open")
      ) {
        this.emit(
          "error",
          new Error(
            `Serial port ${this.path} not found. Please check the device connection.`
          )
        );
      } else if (errorMessage.includes("Input/output error")) {
        this.emit(
          "error",
          new Error(
            `I/O error on ${this.path}. Device may have been disconnected.`
          )
        );
      } else if (errorMessage.length > 0) {
        this.emit("error", new Error(`Serial port error: ${errorMessage}`));
      }
    });

    this.process.on("close", (code, signal) => {
      this.isConnected = false;
      this.connectionHealthy = false;

      if (code !== 0 && code !== null) {
        this.emit("error", new Error(`Process exited with code ${code}`));
      } else if (signal) {
        this.emit("error", new Error(`Process terminated by signal ${signal}`));
      } else {
        this.emit("close");
      }
    });

    this.process.on("error", (error) => {
      this.isConnected = false;
      this.connectionHealthy = false;
      this.emit("error", error);
    });
  }

  /**
   * Writes data using internal buffer with flow control
   * 
   * Queues write operations to prevent overwhelming the serial port
   * and provides backpressure handling.
   * 
   * @private
   * @param {Buffer} data - Data to write to the port
   * @returns {Promise<void>} Resolves when data is written
   * @throws {Error} When buffer overflow occurs or write fails
   */
  private async writeBuffered(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.writeBuffer.length >= this.maxBufferSize) {
        reject(new Error("Write buffer overflow"));
        return;
      }

      this.writeBuffer.push({ data, resolve, reject });

      if (!this.processingBuffer) {
        this.processWriteBuffer();
      }
    });
  }

  /**
   * Processes the write buffer sequentially with flow control
   * 
   * Ensures writes are sent in order with appropriate delays
   * to prevent overwhelming the serial device.
   * 
   * @private
   * @returns {Promise<void>} Resolves when buffer is processed
   */
  private async processWriteBuffer(): Promise<void> {
    this.processingBuffer = true;

    while (this.writeBuffer.length > 0 && this.isConnected) {
      const { data, resolve, reject } = this.writeBuffer.shift()!;

      try {
        const success = this.writeImmediate(data);
        if (success) {
          resolve();
        } else {
          reject(new Error("Write failed"));
        }

        // Small delay to prevent overwhelming the port
        await new Promise((resolve) => setTimeout(resolve, 1));
      } catch (error) {
        reject(error);
      }
    }

    this.processingBuffer = false;
  }

  /**
   * Clears the write buffer and rejects pending write operations
   * 
   * Called when the port is closed or an error occurs to clean up
   * any pending write operations.
   * 
   * @private
   */
  private clearWriteBuffer(): void {
    while (this.writeBuffer.length > 0) {
      const { reject } = this.writeBuffer.shift()!;
      reject(new Error("Port closed"));
    }
  }

  /**
   * Performs an immediate write operation to the serial port
   * 
   * @private
   * @param {Buffer} data - Data to write immediately
   * @returns {boolean} True if write was successful
   * @throws {Error} When port is not open
   */
  private writeImmediate(data: Buffer): boolean {
    if (!this.isConnected || !this.process || !this.process.stdin) {
      throw new Error("Port not open");
    }

    try {
      return this.process.stdin.write(data);
    } catch (error) {
      this.emit("error", error);
      return false;
    }
  }

  /**
   * Legacy synchronous write method for compatibility
   * 
   * Provides compatibility with traditional Node.js SerialPort libraries.
   * For production use, prefer the async writable stream interface.
   * 
   * @param {string|Buffer} data - Data to write to the port
   * @returns {boolean} True if write was successful
   * 
   * @example
   * ```typescript
   * // Write string
   * port.write('Hello, device!\n');
   * 
   * // Write buffer
   * const buffer = Buffer.from([0x01, 0x02, 0x03]);
   * port.write(buffer);
   * ```
   */
  write(data: string | Buffer): boolean {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return this.writeImmediate(buffer);
  }

  /**
   * Sets up periodic connection health monitoring
   * 
   * Monitors data flow and connection status, marking connections as unhealthy
   * if no data is received for 60 seconds. Emits 'healthchange' events.
   * 
   * @private
   * @fires SerialPort#healthchange
   */
  private setupHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(() => {
      if (this.isConnected) {
        const timeSinceData = Date.now() - this.lastDataTime;

        // Consider connection unhealthy if no data for 60 seconds
        if (timeSinceData > 60000) {
          this.connectionHealthy = false;
          this.emit("healthchange", false);
        }
      }
    }, 10000); // Check every 10 seconds
  }

  /**
   * Checks if the serial port connection is healthy
   * 
   * A connection is considered healthy if it's open and has received
   * data within the last 60 seconds.
   * 
   * @returns {boolean} True if connection is healthy
   * 
   * @example
   * ```typescript
   * if (port.isHealthy()) {
   *   console.log('Port is healthy and receiving data');
   * } else {
   *   console.log('Port may have issues or no recent data');
   * }
   * ```
   */
  isHealthy(): boolean {
    return this.isConnected && this.connectionHealthy;
  }

  /**
   * Closes the serial port connection and cleans up resources
   * 
   * Performs a graceful shutdown including:
   * - Stopping health monitoring
   * - Canceling readable/writable streams
   * - Clearing write buffers
   * - Terminating the underlying process
   * - Platform-specific cleanup (lock files, etc.)
   * 
   * @returns {Promise<void>} Resolves when port is fully closed
   * 
   * @example
   * ```typescript
   * // Close port gracefully
   * await port.close();
   * console.log('Port closed successfully');
   * ```
   */
  async close(): Promise<void> {
    // Clear health monitoring
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Clean up streams
    const promises = [];

    if (this.readable_) {
      promises.push(this.readable_.cancel());
    }

    if (this.writable_) {
      promises.push(this.writable_.abort());
    }

    await Promise.all(promises);

    this.readable_ = null;
    this.writable_ = null;

    // Clear write buffer
    this.clearWriteBuffer();

    // Kill process
    if (this.process) {
      this.process.kill("SIGTERM");

      // Force kill after 5 seconds
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 5000);

      this.process = null;
    }

    this.isConnected = false;
    this.connectionHealthy = false;

    // Platform-specific cleanup
    if (this.platform === "darwin") {
      try {
        const lockFile = `/var/spool/uucp/LCK..${this.path.split("/").pop()}`;
        if (existsSync(lockFile)) {
          execSync(`rm -f ${lockFile}`, { stdio: "ignore" });
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Gets comprehensive information about the serial port
   * 
   * Returns both static device information and runtime status including
   * health status, last data time, and reconnection attempts.
   * 
   * @returns {SerialPortInfo} Complete port information with runtime data
   * 
   * @example
   * ```typescript
   * const info = port.getInfo();
   * console.log('Port path:', info.path);
   * console.log('Healthy:', info.isHealthy);
   * console.log('Last data:', new Date(info.lastDataTime));
   * ```
   */
  getInfo(): SerialPortInfo {
    return {
      ...this.portInfo_,
      // Add runtime information
      isHealthy: this.isHealthy(),
      lastDataTime: this.lastDataTime,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * Reconfigures the serial port with new options
   * 
   * Validates new settings and reopens the connection if currently open.
   * Supports changing baud rate, data bits, parity, and other settings.
   * 
   * @param {SerialOptions} options - New serial port configuration
   * @throws {Error} When invalid options are provided
   * 
   * @example
   * ```typescript
   * // Change baud rate
   * await port.reconfigure({ baudRate: 115200 });
   * 
   * // Change multiple settings
   * await port.reconfigure({
   *   baudRate: 9600,
   *   dataBits: 7,
   *   parity: 'even'
   * });
   * ```
   */
  async reconfigure(options: SerialOptions): Promise<void> {
    // Validate options
    if (
      options.baudRate &&
      (options.baudRate < 50 || options.baudRate > 4000000)
    ) {
      throw new Error("Invalid baud rate");
    }

    this.serialOptions_ = { ...this.serialOptions_, ...options };
    
    // Update public baudRate property if it was changed
    if (options.baudRate) {
      this.baudRate = options.baudRate;
    }

    if (this.isConnected) {
      await this.close();
      await this.open(this.serialOptions_);
    }
  }

  /**
   * Sets control signals on the serial port
   * 
   * Controls hardware signals like DTR (Data Terminal Ready) and RTS (Request To Send).
   * Useful for device programming and flow control. Platform support varies.
   * 
   * @param {SerialOutputSignals} signals - Signal states to set
   * 
   * @example
   * ```typescript
   * // Reset Arduino by toggling DTR
   * await port.setSignals({ dataTerminalReady: false });
   * await new Promise(resolve => setTimeout(resolve, 100));
   * await port.setSignals({ dataTerminalReady: true });
   * 
   * // Enable RTS for flow control
   * await port.setSignals({ requestToSend: true });
   * ```
   */
  async setSignals(signals: SerialOutputSignals): Promise<void> {
    // For Unix-like systems, we can use stty for some signal control
    if (this.platform !== "win32" && this.isConnected) {
      const commands = [];

      if (signals.dataTerminalReady !== undefined) {
        commands.push(signals.dataTerminalReady ? "dtr" : "-dtr");
      }

      if (signals.requestToSend !== undefined) {
        commands.push(signals.requestToSend ? "rts" : "-rts");
      }

      if (commands.length > 0) {
        try {
          const sttyCmd =
            this.platform === "darwin"
              ? `stty -f ${this.path} ${commands.join(" ")}`
              : `stty -F ${this.path} ${commands.join(" ")}`;
          execSync(sttyCmd, { stdio: "ignore" });
        } catch (error) {
          // Signal control is optional - don't fail if not supported
        }
      }
    }
  }

  /**
   * Forgets the port and prevents automatic reconnection
   * 
   * Closes the port and sets reconnection attempts to maximum
   * to prevent automatic reconnection attempts.
   * 
   * @returns {Promise<void>} Resolves when port is forgotten
   * 
   * @example
   * ```typescript
   * // Permanently close and forget the port
   * await port.forget();
   * console.log('Port will not attempt to reconnect');
   * ```
   */
  async forget(): Promise<void> {
    await this.close();
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent auto-reconnection
  }

  /**
   * Gets the current connection status of the port
   * 
   * @readonly
   * @returns {boolean} True if port is currently open and connected
   * 
   * @example
   * ```typescript
   * if (port.isOpen) {
   *   console.log('Port is ready for communication');
   * } else {
   *   console.log('Port needs to be opened first');
   * }
   * ```
   */
  get isOpen(): boolean {
    return this.isConnected;
  }
}

/**
 * Enhanced Serial interface with better port management
 * 
 * Provides a high-level interface for managing multiple serial ports
 * with caching and Web Serial API compatibility. Implements the navigator.serial
 * interface for browser-like usage in Node.js environments.
 * 
 * Features:
 * - Port caching to prevent duplicate instances
 * - Filter-based port selection
 * - Web Serial API compatible methods
 * - Automatic port discovery and management
 * 
 * @class Serial
 * 
 * @example
 * ```typescript
 * // Request a specific port
 * const port = await serial.requestPort({
 *   filters: [{ usbVendorId: 0x2341 }] // Arduino
 * });
 * 
 * // Get all available ports
 * const allPorts = await serial.getPorts();
 * ```
 */
class Serial {
  private portCache: Map<string, SerialPort> = new Map();

  /**
   * Requests access to a serial port with optional filtering
   * 
   * Mimics the Web Serial API requestPort method. Returns the first port
   * that matches the provided filters, or the first available port if no
   * filters are specified.
   * 
   * @param {SerialPortRequestOptions} [options] - Port selection options
   * @returns {Promise<SerialPort>} The selected serial port
   * @throws {Error} When no ports are available or match filters
   * 
   * @example
   * ```typescript
   * // Request any available port
   * const port = await serial.requestPort();
   * 
   * // Request Arduino port specifically
   * const arduinoPort = await serial.requestPort({
   *   filters: [{ usbVendorId: 0x2341 }]
   * });
   * ```
   */
  async requestPort(options?: SerialPortRequestOptions): Promise<SerialPort> {
    const ports = await SerialPort.list();

    if (ports.length === 0) {
      throw new Error("No serial ports available");
    }

    let filteredPorts = ports;

    // Apply filters if provided
    if (options?.filters && options.filters.length > 0) {
      filteredPorts = ports.filter((port) =>
        options.filters!.some(
          (filter) =>
            (!filter.usbVendorId || port.usbVendorId === filter.usbVendorId) &&
            (!filter.usbProductId || port.usbProductId === filter.usbProductId)
        )
      );

      if (filteredPorts.length === 0) {
        throw new Error("No ports match the specified filters");
      }
    }

    // Return first matching port
    const portInfo = filteredPorts[0];
    const cacheKey = portInfo.path!;

    if (this.portCache.has(cacheKey)) {
      return this.portCache.get(cacheKey)!;
    }

    const port = new SerialPort(portInfo);
    this.portCache.set(cacheKey, port);

    return port;
  }

  /**
   * Gets all available serial ports
   * 
   * Returns SerialPort instances for all detected serial devices.
   * Uses caching to ensure the same port path returns the same instance.
   * 
   * @returns {Promise<SerialPort[]>} Array of available serial ports
   * 
   * @example
   * ```typescript
   * const ports = await serial.getPorts();
   * 
   * for (const port of ports) {
   *   const info = port.getInfo();
   *   console.log(`Port: ${info.path} (${info.manufacturer})`);
   * }
   * ```
   */
  async getPorts(): Promise<SerialPort[]> {
    const ports = await SerialPort.list();

    return ports.map((portInfo) => {
      const cacheKey = portInfo.path!;

      if (this.portCache.has(cacheKey)) {
        return this.portCache.get(cacheKey)!;
      }

      const port = new SerialPort(portInfo);
      this.portCache.set(cacheKey, port);

      return port;
    });
  }
}

/**
 * Global serial interface instance
 * 
 * Pre-instantiated Serial class that provides the navigator.serial-like interface.
 * This is the main entry point for serial port operations in CLI environments.
 * 
 * @type {Serial}
 * @example
 * ```typescript
 * import { serial } from './serialport';
 * 
 * const port = await serial.requestPort();
 * await port.open({ baudRate: 115200 });
 * ```
 */
export const serial = new Serial();

/**
 * Polyfills the Web Serial API in CLI environments
 * 
 * Adds the serial interface to globalThis.navigator.serial to provide
 * Web Serial API compatibility in Node.js environments. This allows
 * browser-targeted code to work in CLI applications.
 * 
 * @example
 * ```typescript
 * import { polyfillWebSerial } from './serialport';
 * 
 * polyfillWebSerial();
 * 
 * // Now you can use navigator.serial like in browsers
 * const port = await navigator.serial.requestPort();
 * ```
 */
export function polyfillWebSerial(): void {
  // @ts-ignore
  globalThis.navigator = globalThis.navigator || {};
  // @ts-ignore
  globalThis.navigator.serial = serial;
}

/**
 * Automatic polyfill for CLI environments
 * 
 * Automatically adds Web Serial API support when running in Node.js
 * without a browser window object.
 */
if (typeof window === "undefined" && typeof navigator === "undefined") {
  polyfillWebSerial();
}

/**
 * Default export provides the SerialPort class
 * 
 * @default SerialPort
 * @example
 * ```typescript
 * import SerialPort from './serialport';
 * 
 * const port = new SerialPort({ path: '/dev/ttyUSB0', baudRate: 9600 });
 * await port.open();
 * ```
 */
export default SerialPort;
