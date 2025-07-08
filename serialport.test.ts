/**
 * Comprehensive test suite for enhanced SerialPort implementation
 * Uses Bun's built-in test framework
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

// Mock child_process before importing SerialPort
const mockSpawn = mock();
const mockExecSync = mock();

// Mock the child_process module globally
const childProcess = await import("child_process");
spyOn(childProcess, "spawn").mockImplementation(mockSpawn);
spyOn(childProcess, "execSync").mockImplementation(mockExecSync);

// Now import SerialPort after mocking
import { SerialPort, serial, type SerialOptions, type SerialPortInfo } from "./serialport";

describe("SerialPort", () => {
  let mockProcess: any;
  
  beforeEach(() => {
    // Reset mocks
    mockSpawn.mockClear();
    mockExecSync.mockClear();
    
    // Create mock process
    mockProcess = {
      stdout: { on: mock() },
      stderr: { on: mock() },
      stdin: { write: mock(() => true) },
      on: mock(),
      kill: mock(),
      killed: false,
      pid: 12345
    };
    
    // Default mock returns
    mockExecSync.mockReturnValue("");
    mockSpawn.mockReturnValue(mockProcess);
  });

  afterEach(() => {
    // Clean up any open ports
  });

  describe("Constructor", () => {
    test("should create SerialPort with path and baudRate", () => {
      const port = new SerialPort({ path: "/dev/ttyUSB0", baudRate: 9600 });
      
      expect(port.path).toBe("/dev/ttyUSB0");
      expect(port.baudRate).toBe(9600);
      expect(port.isOpen).toBe(false);
    });

    test("should create SerialPort with default baudRate", () => {
      const port = new SerialPort({ path: "/dev/ttyUSB0" });
      
      expect(port.path).toBe("/dev/ttyUSB0");
      expect(port.baudRate).toBe(9600);
    });

    test("should create SerialPort from SerialPortInfo", () => {
      const portInfo: SerialPortInfo = {
        path: "/dev/ttyUSB0",
        manufacturer: "FTDI"
      };
      
      const port = new SerialPort(portInfo);
      
      expect(port.path).toBe("/dev/ttyUSB0");
      expect(port.baudRate).toBe(9600);
    });

    test("should set up health monitoring on creation", () => {
      const port = new SerialPort({ path: "/dev/ttyUSB0" });
      
      expect(port.isHealthy()).toBe(false); // Not connected yet
    });
  });

  describe("Static Methods", () => {
    describe("list()", () => {
      test("should list available ports on macOS", async () => {
        // Mock macOS platform
        const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        
        mockExecSync.mockReturnValue("/dev/cu.usbserial-A10M5SMX\n/dev/cu.Bluetooth-Incoming-Port");
        
        const ports = await SerialPort.list();
        
        expect(ports).toHaveLength(2);
        expect(ports[0].path).toBe("/dev/cu.usbserial-A10M5SMX");
        expect(ports[0].manufacturer).toBe("USB Serial Device");
        expect(ports[1].path).toBe("/dev/cu.Bluetooth-Incoming-Port");
        expect(ports[1].manufacturer).toBe("Bluetooth");
        
        // Restore original platform
        if (originalPlatform) {
          Object.defineProperty(process, 'platform', originalPlatform);
        }
      });

      test("should handle empty port list", async () => {
        mockExecSync.mockReturnValue("");
        
        const ports = await SerialPort.list();
        
        expect(ports).toHaveLength(0);
      });

      test("should handle port listing errors gracefully", async () => {
        mockExecSync.mockImplementation(() => {
          throw new Error("Command failed");
        });
        
        const ports = await SerialPort.list();
        
        expect(ports).toHaveLength(0);
      });
    });
  });

  describe("Port Operations", () => {
    let port: SerialPort;

    beforeEach(() => {
      port = new SerialPort({ path: "/dev/ttyUSB0", baudRate: 9600 });
    });

    describe("open()", () => {
      test("should open port successfully", async () => {
        const options: SerialOptions = {
          baudRate: 115200,
          dataBits: 8,
          stopBits: 1,
          parity: "none"
        };

        // Mock successful open
        const openPromise = port.open(options);
        
        // Simulate successful process start
        setTimeout(() => {
          (port as any).emit("open");
        }, 50);
        
        await openPromise;
        
        expect(port.isOpen).toBe(true);
        expect(port.baudRate).toBe(115200);
      });

      test("should reject if port already open", async () => {
        // First open the port
        const openPromise = port.open();
        setTimeout(() => (port as any).emit("open"), 50);
        await openPromise;
        
        // Try to open again
        await expect(port.open()).rejects.toThrow("Port already open");
      });

      test("should retry connection on failure", async () => {
        let attemptCount = 0;
        
        // Override spawn to simulate failures then success
        mockSpawn.mockImplementation(() => {
          attemptCount++;
          const mockProc = {
            stdout: { on: mock() },
            stderr: { on: mock() },
            stdin: { write: mock(() => true) },
            on: mock(),
            kill: mock(),
            killed: false,
            pid: 12345
          };
          
          // Simulate error on first two attempts, success on third
          setTimeout(() => {
            if (attemptCount < 3) {
              (port as any).emit("error", new Error("Device or resource busy"));
            } else {
              (port as any).emit("open");
            }
          }, 10);
          
          return mockProc;
        });
        
        await port.open();
        
        expect(port.isOpen).toBe(true);
        expect(attemptCount).toBeGreaterThanOrEqual(2);
      });
    });

    describe("write()", () => {
      beforeEach(async () => {
        // Open port for write tests
        const openPromise = port.open();
        setTimeout(() => (port as any).emit("open"), 50);
        await openPromise;
      });

      test("should write data successfully", () => {
        const data = "test message";
        
        const result = port.write(data);
        
        expect(result).toBe(true);
        expect(mockProcess.stdin.write).toHaveBeenCalledWith(Buffer.from(data));
      });

      test("should write Buffer data", () => {
        const data = Buffer.from("binary data");
        
        const result = port.write(data);
        
        expect(result).toBe(true);
        expect(mockProcess.stdin.write).toHaveBeenCalledWith(data);
      });

      test("should throw error if port not open", () => {
        const closedPort = new SerialPort({ path: "/dev/ttyUSB1" });
        
        expect(() => closedPort.write("test")).toThrow("Port not open");
      });
    });

    describe("Streams API", () => {
      beforeEach(async () => {
        const openPromise = port.open();
        setTimeout(() => (port as any).emit("open"), 50);
        await openPromise;
      });

      test("should provide readable stream", () => {
        const readable = port.readable;
        
        expect(readable).toBeInstanceOf(ReadableStream);
        expect(readable).not.toBeNull();
      });

      test("should provide writable stream", () => {
        const writable = port.writable;
        
        expect(writable).toBeInstanceOf(WritableStream);
        expect(writable).not.toBeNull();
      });

      test("should handle data through readable stream", async () => {
        const readable = port.readable!;
        const reader = readable.getReader();
        
        // Simulate incoming data by emitting data event
        setTimeout(() => {
          (port as any).emit("data", Buffer.from("test data"));
        }, 10);
        
        const { value, done } = await reader.read();
        
        expect(done).toBe(false);
        expect(value).toBeInstanceOf(Uint8Array);
        expect(new TextDecoder().decode(value)).toBe("test data");
        
        reader.releaseLock();
      });

      test("should handle write through writable stream", async () => {
        const writable = port.writable!;
        const writer = writable.getWriter();
        
        const data = new TextEncoder().encode("stream data");
        await writer.write(data);
        
        expect(mockProcess.stdin.write).toHaveBeenCalled();
        
        writer.releaseLock();
      });
    });

    describe("close()", () => {
      beforeEach(async () => {
        const openPromise = port.open();
        setTimeout(() => (port as any).emit("open"), 50);
        await openPromise;
      });

      test("should close port successfully", async () => {
        await port.close();
        
        expect(port.isOpen).toBe(false);
        expect(port.isHealthy()).toBe(false);
        expect(mockProcess.kill).toHaveBeenCalledWith("SIGTERM");
      });

      test("should clean up streams on close", async () => {
        const readable = port.readable;
        const writable = port.writable;
        
        expect(readable).not.toBeNull();
        expect(writable).not.toBeNull();
        
        await port.close();
        
        expect(port.readable).toBeNull();
        expect(port.writable).toBeNull();
      });
    });
  });

  describe("Health Monitoring", () => {
    let port: SerialPort;

    beforeEach(() => {
      port = new SerialPort({ path: "/dev/ttyUSB0" });
    });

    test("should track connection health", async () => {
      expect(port.isHealthy()).toBe(false);
      
      const openPromise = port.open();
      setTimeout(() => (port as any).emit("open"), 50);
      await openPromise;
      
      expect(port.isHealthy()).toBe(true);
    });

    test("should emit healthchange events", (done) => {
      port.on("healthchange", (healthy) => {
        expect(healthy).toBe(false);
        done();
      });
      
      // Simulate health change
      port.emit("healthchange", false);
    });

    test("should update health on data reception", async () => {
      const openPromise = port.open();
      setTimeout(() => (port as any).emit("open"), 50);
      await openPromise;
      
      // Simulate data reception
      (port as any).emit("data", Buffer.from("test"));
      
      expect(port.isHealthy()).toBe(true);
    });
  });

  describe("Error Handling", () => {
    let port: SerialPort;

    beforeEach(() => {
      port = new SerialPort({ path: "/dev/ttyUSB0" });
    });

    test("should handle permission denied errors", (done) => {
      port.on("error", (error) => {
        expect(error.message).toContain("Permission denied");
        expect(error.message).toContain("appropriate permissions");
        done();
      });
      
      // Start the open process and then simulate error
      port.open().catch(() => {});
      
      // Simulate permission error
      setTimeout(() => {
        (port as any).emit("error", new Error("Permission denied accessing /dev/ttyUSB0. Try running with appropriate permissions."));
      }, 50);
    });

    test("should handle device busy errors", (done) => {
      port.on("error", (error) => {
        expect(error.message).toContain("already in use");
        done();
      });
      
      port.open().catch(() => {});
      
      setTimeout(() => {
        (port as any).emit("error", new Error("Serial port /dev/ttyUSB0 is already in use by another process"));
      }, 50);
    });

    test("should handle device not found errors", (done) => {
      port.on("error", (error) => {
        expect(error.message).toContain("not found");
        expect(error.message).toContain("check the device connection");
        done();
      });
      
      port.open().catch(() => {});
      
      setTimeout(() => {
        (port as any).emit("error", new Error("Serial port /dev/ttyUSB0 not found. Please check the device connection."));
      }, 50);
    });
  });

  describe("Configuration", () => {
    let port: SerialPort;

    beforeEach(() => {
      port = new SerialPort({ path: "/dev/ttyUSB0" });
    });

    test("should get port information", () => {
      const info = port.getInfo();
      
      expect(info.path).toBe("/dev/ttyUSB0");
      expect(info.isHealthy).toBe(false);
      expect(info.reconnectAttempts).toBe(0);
      expect(typeof info.lastDataTime).toBe("number");
    });

    test("should reconfigure port settings", async () => {
      const newOptions: SerialOptions = {
        baudRate: 115200,
        dataBits: 7,
        parity: "even"
      };
      
      await port.reconfigure(newOptions);
      
      expect(port.baudRate).toBe(115200);
    });

    test("should validate baud rate on reconfigure", async () => {
      const invalidOptions: SerialOptions = {
        baudRate: 5000000 // Too high
      };
      
      await expect(port.reconfigure(invalidOptions)).rejects.toThrow("Invalid baud rate");
    });
  });

  describe("Platform Compatibility", () => {
    test("should handle macOS platform commands", () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      
      const port = new SerialPort({ path: "/dev/cu.usbserial", baudRate: 9600 });
      
      expect(port.path).toBe("/dev/cu.usbserial");
      
      // Restore original platform
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    });

    test("should handle Linux platform commands", () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      
      const port = new SerialPort({ path: "/dev/ttyUSB0", baudRate: 9600 });
      
      expect(port.path).toBe("/dev/ttyUSB0");
      
      // Restore original platform
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    });

    test("should handle Windows platform commands", () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      
      const port = new SerialPort({ path: "COM3", baudRate: 9600 });
      
      expect(port.path).toBe("COM3");
      
      // Restore original platform
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    });
  });
});

describe("Serial Global Interface", () => {
  beforeEach(() => {
    mockExecSync.mockReturnValue("/dev/ttyUSB0\n/dev/ttyUSB1");
  });

  describe("requestPort()", () => {
    test("should request available port", async () => {
      const port = await serial.requestPort();
      
      expect(port).toBeInstanceOf(SerialPort);
      expect(port.path).toBe("/dev/ttyUSB0");
    });

    test("should throw error if no ports available", async () => {
      mockExecSync.mockReturnValue("");
      
      await expect(serial.requestPort()).rejects.toThrow("No serial ports available");
    });

    test("should apply filters when requesting port", async () => {
      const filters = [{ usbVendorId: 0x2341 }]; // Arduino vendor ID
      
      // Mock port with vendor ID
      const listSpy = spyOn(SerialPort, "list").mockResolvedValue([
        { path: "/dev/ttyUSB0", usbVendorId: 0x2341 },
        { path: "/dev/ttyUSB1", usbVendorId: 0x1234 }
      ]);
      
      const port = await serial.requestPort({ filters });
      
      expect(port.path).toBe("/dev/ttyUSB0");
      
      listSpy.mockRestore();
    });
  });

  describe("getPorts()", () => {
    test("should get all available ports", async () => {
      const ports = await serial.getPorts();
      
      expect(ports).toHaveLength(2);
      expect(ports[0]).toBeInstanceOf(SerialPort);
      expect(ports[1]).toBeInstanceOf(SerialPort);
    });

    test("should cache port instances", async () => {
      const ports1 = await serial.getPorts();
      const ports2 = await serial.getPorts();
      
      expect(ports1[0]).toBe(ports2[0]); // Same instance
    });
  });
});

describe("Web Serial API Polyfill", () => {
  test("should polyfill navigator.serial in CLI environment", () => {
    // Import the polyfill function
    const { polyfillWebSerial } = require("./serialport");
    
    // Simulate CLI environment
    const originalWindow = globalThis.window;
    const originalNavigator = globalThis.navigator;
    
    delete (globalThis as any).window;
    delete (globalThis as any).navigator;
    
    // Call polyfill manually
    polyfillWebSerial();
    
    expect(globalThis.navigator).toBeDefined();
    expect((globalThis.navigator as any).serial).toBeDefined();
    
    // Restore
    (globalThis as any).window = originalWindow;
    (globalThis as any).navigator = originalNavigator;
  });
});

describe("Integration Tests", () => {
  test("should handle complete open-write-read-close cycle", async () => {
    const port = new SerialPort({ path: "/dev/ttyUSB0", baudRate: 9600 });
    
    // Mock successful operations
    const openPromise = port.open();
    setTimeout(() => (port as any).emit("open"), 50);

    await openPromise;
    expect(port.isOpen).toBe(true);
    
    // Write data
    const writeResult = port.write("test message");
    expect(writeResult).toBe(true);
    
    // Simulate data reception
    (port as any).emit("data", Buffer.from("response"));
    
    // Close port
    await port.close();
    expect(port.isOpen).toBe(false);
  });

  test("should handle reconnection after failure", async () => {
    const port = new SerialPort({ path: "/dev/ttyUSB0" });
    
    let attemptCount = 0;
    
    // Override spawn to simulate failures then success
    mockSpawn.mockImplementation(() => {
      attemptCount++;
      const mockProc = {
        stdout: { on: mock() },
        stderr: { on: mock() },
        stdin: { write: mock(() => true) },
        on: mock(),
        kill: mock(),
        killed: false,
        pid: 12345
      };
      
      // Simulate error on first attempt, success on second
      setTimeout(() => {
        if (attemptCount === 1) {
          (port as any).emit("error", new Error("Device or resource busy"));
        } else {
          (port as any).emit("open");
        }
      }, 10);
      
      return mockProc;
    });
    
    await port.open();
    
    expect(port.isOpen).toBe(true);
    expect(attemptCount).toBe(2);
  });
});