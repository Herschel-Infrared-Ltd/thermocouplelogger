# Thermocouple Logger

A Node.js application for reading and monitoring temperature data from the [HH-4208SD 12-Channel Thermocouple Data Logger](https://www.thermosensedirect.com/hh-4208sd-12-channel-thermocouple-data-logger.html) via RS-232 serial communication.

## Features

- **Real-time serial data monitoring** - Continuously reads thermocouple data from HH-4208SD via RS-232
- **Live console dashboard** - Dynamic terminal table that updates in place without scrolling
- **Web dashboard** - Clean, modern web interface for viewing live temperature readings
- **Auto-detection** - Automatically discovers and configures channels from incoming data
- **REST API** - RESTful endpoints for programmatic access to temperature data
- **Prometheus metrics** - Built-in metrics endpoint for monitoring and alerting
- **Multi-channel support** - Support for up to 12 thermocouple channels with auto-detection
- **Multiple thermocouple types** - Supports K, J, T, E, R, S type thermocouples
- **Connection monitoring** - Tracks data freshness and connection status

## Requirements

- **Node.js 22+** (recommended)
- **HH-4208SD 12-Channel Thermocouple Data Logger** with RS-232 capability
- **USB-to-RS232 adapter** (if using USB connection)
- **Compatible OS**: Windows, macOS, or Linux

## Project Structure

```bash
thermocouplelogger/
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── config.ts            # Configuration management and setup
├── index.ts             # Main entry point (serial + web server)
├── server.ts            # Web server and API endpoints  
├── logger.ts            # Enhanced logging with dashboard mode
├── parser.ts            # Shared data parsing and validation
├── public/
│   └── index.html       # Web dashboard interface
└── config.json          # Runtime configuration (auto-generated)
```

## Installation

1. **Clone and install dependencies:**

   ```bash
   npm install
   ```

2. **Set up device configuration:**

   ```bash
   npm run setup
   ```

   This will:

   - Scan for available serial ports
   - Guide you through selecting your HH-4208SD device
   - Test data format and validate HH-4208SD configuration
   - Create a configuration file for port settings

3. **Optional**: Customize thermocouple names by editing the generated `config.json` file

   **Note**: The application auto-detects channels from live data, so configuration is optional!

## Configuration

The application uses a `config.json` file that defines:

- **Serial port settings** (path, baud rate)
- **Thermocouple channel mappings** (name, type, channel number)

Example configuration:

```json
{
  "serial": {
    "path": "/dev/tty.usbserial-AB0N89MV",
    "baudRate": 9600
  },
  "thermocouples": [
    {
      "name": "Reactor Core",
      "type": "K",
      "channel": 1
    },
    {
      "name": "Heat Exchanger",
      "type": "J",
      "channel": 2
    }
  ]
}
```

## Usage

### Start the complete application

```bash
npm start
```

This starts both serial monitoring and web server with a live console dashboard.

### Silent mode (suppress console output)

```bash
npm run start:silent
```

### Individual components

**Web server only:**

```bash
npm run server
```

## User Interfaces

### Console Dashboard

The terminal displays a live-updating table showing:
- Real-time temperature readings for all active channels
- Connection status and data age for each thermocouple
- Auto-detected channel information
- Individual temperature events above the live table

### Web Interface

Access the web dashboard at: **<http://localhost:3000>**

The web dashboard displays:
- Live temperature readings for all detected and configured channels
- Connection status for each thermocouple
- Last update timestamps and detection metadata
- Visual indicators for connected/disconnected channels

## API Endpoints

### GET `/api/readings`

Returns current readings for all active thermocouples (detected + configured)

```json
{
  "readings": [
    {
      "id": 1,
      "name": "Reactor Core",
      "type": "K",
      "temperature": 23.5,
      "connected": true,
      "lastUpdate": "2024-01-15T10:30:00.000Z",
      "ageSeconds": 2.1
    }
  ],
  "totalActive": 2,
  "totalDetected": 1,
  "totalConfigured": 1,
  "timestamp": "2024-01-15T10:30:02.000Z"
}
```

### GET `/api/readings/:name`

Returns reading for a specific thermocouple by name

```json
{
  "Reactor Core": 23.5,
  "temperature": 23.5,
  "type": "K",
  "channel": 1,
  "lastUpdate": "2024-01-15T10:30:00.000Z"
}
```

### GET `/api/config`

Returns current thermocouple configuration

### GET `/health`

Health check endpoint showing system status

### GET `/metrics`

Prometheus metrics endpoint for monitoring integration

## Serial Communication

The application communicates with the HH-4208SD using:

- **Protocol**: RS-232 serial
- **Default baud rate**: 9600
- **Data format**: Custom protocol with STX headers and hex channel identifiers
- **Channel mapping**: Channels 1-12 mapped to hex values 0x41-0x4C

## Monitoring & Alerting

Prometheus metrics are available at `/metrics` including:

- `thermocouple_channel_temperature` - Current temperature readings
- `thermocouple_channel_connected` - Connection status (1=connected, 0=disconnected)
- `thermocouple_channel_last_update_seconds` - Seconds since last data update
- `thermocouple_info` - Configuration metadata

## Hardware Setup

1. **Connect HH-4208SD** to your computer via RS-232 (or USB-to-RS232 adapter)
2. **Configure the data logger** to output continuous data
3. **Connect thermocouples** to the desired channels (1-12)
4. **Power on** the HH-4208SD device
5. **Run setup** command to detect the serial port

## Troubleshooting

**No serial ports detected:**

- Ensure HH-4208SD is connected and powered on
- Check USB-to-RS232 driver installation
- Try different USB ports

**No data received:**

- Verify baud rate settings (default: 9600)
- Check that data logging is enabled on HH-4208SD
- Confirm thermocouples are properly connected

**Connection timeouts:**

- Channels are considered disconnected after 60 seconds without data
- Check thermocouple connections and HH-4208SD configuration
