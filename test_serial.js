import { SerialPort } from './serialport.ts';

console.log('Testing serial port connection...');

const port = new SerialPort({ 
  path: '/dev/tty.usbserial-A10M5SMX', 
  baudRate: 9600 
});

let dataReceived = false;

port.on('data', (data) => {
  dataReceived = true;
  console.log('Data received:', data.toString().trim());
  console.log('Hex:', data.toString('hex'));
  console.log('Length:', data.length);
});

port.on('error', (err) => {
  console.log('Serial error:', err.message);
  process.exit(1);
});

port.on('open', () => {
  console.log('Serial port opened successfully');
  console.log('Listening for data from HH-4208SD...');
});

port.on('close', () => {
  console.log('Serial port closed');
});

// Test for 15 seconds
setTimeout(() => {
  if (!dataReceived) {
    console.log('❌ No data received in 15 seconds');
    console.log('Check HH-4208SD configuration:');
    console.log('1. Sampling rate set to "1" (1 second)');
    console.log('2. USB switch set to position "2" (photo mode)');
    console.log('3. Data logging enabled');
    console.log('4. Device is powered on and connected');
  } else {
    console.log('✅ Data reception confirmed');
  }
  port.close();
  process.exit(0);
}, 15000);