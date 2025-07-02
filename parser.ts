/**
 * HH-4208SD Thermocouple Data Parser
 * Centralized parsing logic for HH-4208SD data format
 */

/** Channel mapping from hex identifiers to decimal channel numbers */
export const CHANNEL_MAP: { [key: string]: number } = {
  "41": 1,  // 4 + 1 = Channel 1
  "42": 2,  // 4 + 2 = Channel 2
  "43": 3,  // 4 + 3 = Channel 3
  "44": 4,  // 4 + 4 = Channel 4
  "45": 5,  // 4 + 5 = Channel 5
  "46": 6,  // 4 + 6 = Channel 6
  "47": 7,  // 4 + 7 = Channel 7
  "48": 8,  // 4 + 8 = Channel 8
  "49": 9,  // 4 + 9 = Channel 9
  "4A": 10, // 4 + A = Channel 10
  "4B": 11, // 4 + B = Channel 11
  "4C": 12, // 4 + C = Channel 12
};

/** Valid channel hex identifiers for validation */
export const VALID_CHANNEL_IDS = Object.keys(CHANNEL_MAP);

/**
 * Interface for parsed thermocouple data message
 */
export interface ParsedMessage {
  /** Whether the message is valid HH-4208SD format */
  valid: boolean;
  /** Hex channel identifier (e.g., "41", "42") */
  channelHex?: string;
  /** Decimal channel number (1-12) */
  channelNumber?: number;
  /** Parsed temperature value */
  temperature?: number;
  /** Temperature unit ('C' or 'F') */
  temperatureUnit?: string;
  /** Temperature polarity ('+' or '-') */
  polarity?: string;
  /** Decimal point position */
  decimalPoint?: number;
  /** Raw sensor data string */
  sensorData?: string;
  /** Error message if parsing failed */
  error?: string;
}

/**
 * Validates if a message has the correct HH-4208SD format
 * Expected format: STX (0x02) + 2-char hex channel ID + sensor data
 * @param message - Raw message string to validate
 * @returns True if message has valid HH-4208SD format
 */
export function isValidHH4208SDFormat(message: string): boolean {
  // Check minimum length and STX header
  if (message.length < 3 || message.charCodeAt(0) !== 0x02) {
    return false;
  }
  
  // Extract and validate channel identifier
  const channelHex = message.substring(1, 3).toUpperCase();
  return VALID_CHANNEL_IDS.includes(channelHex);
}

/**
 * Parses a complete HH-4208SD thermocouple data message
 * Expected format: STX + 2-char hex channel ID + sensor data + temperature (last 3 digits)
 * @param message - Complete message string to parse
 * @returns Parsed message data with validation results
 */
export function parseHH4208SDMessage(message: string): ParsedMessage {
  // Validate basic format
  if (!isValidHH4208SDFormat(message)) {
    return {
      valid: false,
      error: message.length < 3 
        ? "Message too short" 
        : message.charCodeAt(0) !== 0x02 
          ? "Missing STX header" 
          : "Invalid channel identifier"
    };
  }

  try {
    // Remove STX character and extract data
    const data = message.substring(1);
    
    if (data.length < 6) {
      return {
        valid: false,
        error: `Message too short: ${data.length} chars, need at least 6`
      };
    }
    
    // Parse HH-4208SD format: 4X TTPP DDDDDDDD
    const prefix = data[0];           // Should be '4'
    const channel = data[1];          // 1-9, A-C for channels 1-12
    const tempUnit = data.substring(2, 4);  // 01=C, 02=F
    const polarity = data[4];         // 0=positive, 1=negative
    const decimal = data[5];          // Decimal point position
    const remaining = data.substring(6);
    
    const channelHex = (prefix + channel).toUpperCase();
    const channelNumber = CHANNEL_MAP[channelHex];
    
    if (!channelNumber) {
      return {
        valid: false,
        error: `Invalid channel: ${channelHex}`
      };
    }
    
    // Clean remaining data - remove any non-printable characters except digits
    const cleanRemaining = remaining.replace(/[^\d]/g, '');
    
    // Parse temperature from last 3 digits (temperature * 10)
    const tempMatch = cleanRemaining.match(/(\d{3})$/);
    
    if (!tempMatch) {
      return {
        valid: false,
        channelHex,
        channelNumber,
        sensorData: remaining,
        error: `No temperature digits found in: "${remaining}" (cleaned: "${cleanRemaining}")`
      };
    }
    
    const tempRaw = tempMatch[1];
    let temperature = parseInt(tempRaw, 10) / 10;
    
    // Apply polarity
    if (polarity === '1') {
      temperature = -temperature;
    }
    
    const unit = tempUnit === '01' ? 'C' : tempUnit === '02' ? 'F' : 'Unknown';
    const sign = polarity === '0' ? '+' : '-';
    
    // Validate temperature is a reasonable number
    if (isNaN(temperature) || temperature < -200 || temperature > 2000) {
      return {
        valid: false,
        channelHex,
        channelNumber,
        sensorData: remaining,
        error: `Invalid temperature value: ${tempRaw} from "${cleanRemaining}"`
      };
    }

    return {
      valid: true,
      channelHex,
      channelNumber,
      temperature,
      temperatureUnit: unit,
      polarity: sign,
      decimalPoint: parseInt(decimal, 10),
      sensorData: remaining,
    };
  } catch (error: any) {
    return {
      valid: false,
      error: `Parse error: ${error.message}`
    };
  }
}

/**
 * Processes a buffer of incoming serial data and extracts complete messages
 * Handles partial messages and returns both complete parsed messages and remaining buffer
 * @param buffer - Accumulated buffer string
 * @param newData - New data to append to buffer
 * @returns Object with parsed messages and updated buffer
 */
export function processSerialBuffer(buffer: string, newData: string): {
  messages: ParsedMessage[];
  buffer: string;
} {
  // Append new data to buffer
  buffer += newData;
  
  // Split on carriage return to find complete messages
  const parts = buffer.split('\r');
  
  // Keep the last part as the new buffer (might be incomplete)
  const newBuffer = parts.pop() || '';
  
  // Parse all complete messages
  const messages: ParsedMessage[] = [];
  for (const message of parts) {
    if (message.length > 0) {
      messages.push(parseHH4208SDMessage(message));
    }
  }
  
  return {
    messages,
    buffer: newBuffer
  };
}