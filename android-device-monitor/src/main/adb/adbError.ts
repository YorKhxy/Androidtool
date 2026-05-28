export type AdbErrorCode =
  | 'ADB_NOT_FOUND'
  | 'ADB_TIMEOUT'
  | 'DEVICE_UNAUTHORIZED'
  | 'DEVICE_OFFLINE'
  | 'DEVICE_NOT_FOUND'
  | 'MULTIPLE_DEVICES'
  | 'NETWORK_UNREACHABLE'
  | 'WIFI_CONNECTION_REFUSED'
  | 'TCPDUMP_UNAVAILABLE'
  | 'ADB_COMMAND_FAILED';

type AdbErrorOptions = {
  code: AdbErrorCode;
  message: string;
  hint?: string;
  details?: string;
};

export class AdbCommandError extends Error {
  readonly code: AdbErrorCode;
  readonly hint?: string;
  readonly details?: string;

  constructor(options: AdbErrorOptions) {
    super(options.message);
    this.name = 'AdbCommandError';
    this.code = options.code;
    this.hint = options.hint;
    this.details = options.details;
  }
}

const rawErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? 'Unknown error');
};

const includesAny = (source: string, values: string[]): boolean =>
  values.some((value) => source.includes(value));

export const classifyAdbError = (error: unknown, args: string[] = []): AdbCommandError => {
  const details = rawErrorMessage(error);
  const normalized = details.toLowerCase();
  const command = ['adb', ...args].join(' ');

  if (
    includesAny(normalized, [
      'enoent',
      'not recognized as an internal or external command',
      'is not recognized as an internal or external command',
      'cannot find the file specified',
      'command not found',
    ])
  ) {
    return new AdbCommandError({
      code: 'ADB_NOT_FOUND',
      message: '未检测到可用的 adb。应用内置的 platform-tools 可能缺失，也可能是系统环境里没有 adb。',
      hint: '优先检查发布包里的 resources/platform-tools 是否完整；如果你是在源码环境运行，再确认终端里 `adb version` 能正常执行。',
      details,
    });
  }

  if (includesAny(normalized, ['unauthorized'])) {
    return new AdbCommandError({
      code: 'DEVICE_UNAUTHORIZED',
      message: '设备未授权。请在手机上允许 USB 调试授权后重试。',
      hint: '如果授权弹窗没有出现，尝试重新插拔 USB，或关闭后重新开启 USB 调试。',
      details,
    });
  }

  if (includesAny(normalized, ['offline'])) {
    return new AdbCommandError({
      code: 'DEVICE_OFFLINE',
      message: '设备当前处于离线状态，请检查 USB 调试、数据线或无线调试状态。',
      hint: '可以先执行一次 USB 刷新，必要时重新插拔设备或重新连接 WiFi 调试。',
      details,
    });
  }

  if (includesAny(normalized, ['device not found', 'no devices/emulators found'])) {
    return new AdbCommandError({
      code: 'DEVICE_NOT_FOUND',
      message: '未找到目标设备。请确认设备已连接，并且已经出现在 ADB 设备列表中。',
      hint: '如果是 WiFi 设备，请确认 IP 和端口正确；如果是 USB 设备，请确认调试授权已通过。',
      details,
    });
  }

  if (includesAny(normalized, ['more than one device', 'more than one emulator'])) {
    return new AdbCommandError({
      code: 'MULTIPLE_DEVICES',
      message: '当前存在多个 ADB 设备，操作目标不明确。',
      hint: '请先在设备列表中确认目标设备，再使用带设备 ID 的操作。',
      details,
    });
  }

  if (includesAny(normalized, ['timed out', 'timeout'])) {
    return new AdbCommandError({
      code: 'ADB_TIMEOUT',
      message: 'ADB 操作超时，请检查设备连接状态后重试。',
      hint: '如果是 WiFi 连接，优先确认设备和电脑是否仍在同一局域网。',
      details,
    });
  }

  if (includesAny(normalized, ['connection refused', '10061', 'actively refused'])) {
    return new AdbCommandError({
      code: 'WIFI_CONNECTION_REFUSED',
      message: 'WiFi 连接被拒绝，请确认目标设备已开启无线调试并监听正确端口。',
      hint: '可以先用 USB 连接设备，再在系统开发者选项里确认无线调试状态。',
      details,
    });
  }

  if (
    includesAny(normalized, [
      'no route to host',
      'network is unreachable',
      'cannot assign requested address',
      'name or service not known',
      'unknown host',
    ])
  ) {
    return new AdbCommandError({
      code: 'NETWORK_UNREACHABLE',
      message: '无法访问目标设备网络地址，请检查 IP、端口和局域网连通性。',
      hint: '请确认电脑和设备在同一网络，并且目标 IP 可以被访问。',
      details,
    });
  }

  if (args.includes('tcpdump') || includesAny(normalized, ['tcpdump', 'permission denied'])) {
    return new AdbCommandError({
      code: 'TCPDUMP_UNAVAILABLE',
      message: '设备侧 tcpdump 不可用，或当前权限不足以抓包。',
      hint: '这通常需要设备存在 tcpdump，并具备相应权限；部分机型默认无法直接抓包。',
      details,
    });
  }

  return new AdbCommandError({
    code: 'ADB_COMMAND_FAILED',
    message: `ADB 命令执行失败：${command}`,
    hint: '请检查设备连接状态、调试授权和命令执行环境后重试。',
    details,
  });
};
