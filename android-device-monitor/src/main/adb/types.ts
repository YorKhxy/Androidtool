export interface RawDevice {
  id: string;
  type: string;
}

export interface ParsedDevice {
  id: string;
  name: string;
  model: string;
  manufacturer: string;
  androidVersion: string;
  apiLevel: number;
  connectionType: 'usb' | 'wifi';
}

export interface LogcatOutput {
  pid: number;
  tid: number;
  level: string;
  tag: string;
  message: string;
  timestamp: Date;
}

export interface ProcessData {
  pid: number;
  ppid: number;
  name: string;
  packageName: string;
  cpuUsage: number;
  memoryUsage: number;
  status: 'running' | 'sleeping' | 'zombie';
}

export interface PerformanceData {
  provider: 'android' | 'pico';
  cpuUsage: number;
  memoryUsage: number;
  fps: number;
  networkSpeed: number;
  packageName?: string;
  activityName?: string;
}
