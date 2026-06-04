package com.androidtool.piconetworkhelper.proxy;

import android.util.Log;

import com.androidtool.piconetworkhelper.model.WeakNetworkConfig;
import com.androidtool.piconetworkhelper.shaper.PacketDirection;
import com.androidtool.piconetworkhelper.shaper.PacketDecision;
import com.androidtool.piconetworkhelper.shaper.WeakNetworkShaper;

import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class WeakSocks5Proxy {
    private static final String TAG = "WeakSocks5Proxy";
    private static final int BUFFER_SIZE = 16 * 1024;
    private static final int UDP_BUFFER_SIZE = 64 * 1024;
    private static final int SOCKS_VERSION = 0x05;
    private static final int CMD_CONNECT = 0x01;
    private static final int CMD_UDP_ASSOCIATE = 0x03;
    private static final int ATYP_IPV4 = 0x01;
    private static final int ATYP_DOMAIN = 0x03;
    private static final int ATYP_IPV6 = 0x04;

    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final WeakNetworkConfig config;
    private final WeakNetworkShaper shaper;
    private final Set<UdpAssociation> associations = ConcurrentHashMap.newKeySet();
    private ServerSocket serverSocket;
    private volatile boolean running;

    public WeakSocks5Proxy(WeakNetworkConfig config) {
        this.config = config;
        this.shaper = new WeakNetworkShaper(config);
    }

    public synchronized int start() throws IOException {
        if (running) {
            return getPort();
        }
        serverSocket = new ServerSocket();
        serverSocket.bind(new InetSocketAddress("127.0.0.1", 0));
        running = true;
        executor.execute(this::acceptLoop);
        return getPort();
    }

    public synchronized void stop() {
        running = false;
        // 主动关闭活动的 UDP 关联：DatagramSocket.receive() 不响应线程中断，
        // 必须 close socket 才能解除中继/上游接收循环的阻塞，避免 socket/线程泄漏。
        for (UdpAssociation association : associations) {
            association.close();
        }
        associations.clear();
        closeQuietly(serverSocket);
        executor.shutdownNow();
    }

    public int getPort() {
        return serverSocket == null ? 0 : serverSocket.getLocalPort();
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket client = serverSocket.accept();
                executor.execute(() -> handleClient(client));
            } catch (IOException error) {
                if (running) {
                    Log.w(TAG, "SOCKS accept failed.", error);
                }
            }
        }
    }

    private void handleClient(Socket client) {
        try (Socket ignored = client) {
            client.setTcpNoDelay(true);
            InputStream input = client.getInputStream();
            OutputStream output = client.getOutputStream();
            negotiate(input, output);
            SocksRequest request = readRequest(input);
            if (request.command == CMD_CONNECT) {
                handleConnect(client, output, request);
                return;
            }
            if (request.command == CMD_UDP_ASSOCIATE) {
                handleUdpAssociate(client, output);
                return;
            }
            writeReply(output, 0x07, "0.0.0.0", 0);
        } catch (Exception error) {
            Log.w(TAG, "SOCKS client failed.", error);
        }
    }

    private void handleConnect(Socket client, OutputStream clientOutput, SocksRequest request) throws IOException {
        Socket remote = new Socket();
        try {
            remote.connect(new InetSocketAddress(request.host, request.port), 10000);
            remote.setTcpNoDelay(true);
            SocketAddress localAddress = remote.getLocalSocketAddress();
            int localPort = localAddress instanceof InetSocketAddress
                ? ((InetSocketAddress) localAddress).getPort()
                : 0;
            writeReply(clientOutput, 0x00, "0.0.0.0", localPort);
            executor.execute(() -> pipe(client, remote, PacketDirection.UPLOAD));
            pipe(remote, client, PacketDirection.DOWNLOAD);
        } finally {
            closeQuietly(remote);
        }
    }

    private void pipe(Socket source, Socket target, PacketDirection direction) {
        byte[] buffer = new byte[BUFFER_SIZE];
        try {
            InputStream input = source.getInputStream();
            OutputStream output = target.getOutputStream();
            int read;
            while (running && (read = input.read(buffer)) >= 0) {
                PacketDecision decision = shaper.decide(direction, read);
                if (decision.drop) {
                    continue;
                }
                sleep(decision.delayMs);
                output.write(buffer, 0, read);
                output.flush();
            }
        } catch (Exception ignored) {
            // Socket closure is expected when either side disconnects.
        } finally {
            closeQuietly(source);
            closeQuietly(target);
        }
    }

    /**
     * 处理 SOCKS5 UDP ASSOCIATE。
     *
     * <p>hev-socks5-tunnel 在 {@code udp: 'udp'} 模式下作为 SOCKS5 客户端：先用这条 TCP 控制连接
     * 发起 UDP ASSOCIATE，我们回复一个本地中继端点（BND.ADDR/PORT）；之后 hev 把封装了 SOCKS5
     * UDP 请求头的数据报发到该端点，我们解封装后转发给真实目标，并把目标的回包按相同格式封装回送。
     * 控制连接保持期间维持该 UDP 关联，连接关闭即拆除中继（Fullcone NAT：一个关联可对多个目标）。
     */
    private void handleUdpAssociate(Socket client, OutputStream output) throws IOException {
        DatagramSocket relay = new DatagramSocket(new InetSocketAddress("127.0.0.1", 0));
        UdpAssociation association = new UdpAssociation(relay);
        associations.add(association);
        try {
            writeReply(output, 0x00, "127.0.0.1", relay.getLocalPort());
            executor.execute(association::relayLoop);
            // TCP 控制连接仅作为关联的生命周期信号；读到 EOF（hev 关闭）即拆除。
            InputStream input = client.getInputStream();
            byte[] drain = new byte[256];
            while (running && input.read(drain) != -1) {
                // 正常情况下控制连接不再承载数据，忽略读取到的内容。
            }
        } finally {
            associations.remove(association);
            association.close();
        }
    }

    /** 一个 UDP ASSOCIATE 关联：面向 hev 的中继 socket + 按目标分流的上游 NAT 表。 */
    private final class UdpAssociation {
        private final DatagramSocket relay;
        private final Map<String, UpstreamFlow> flows = new ConcurrentHashMap<>();
        // 标准 SOCKS5 UDP ASSOCIATE 下，hev 这条关联用单个固定本地 UDP 端点向中继收发，
        // 因此回包统一发往最近一次上行包的来源地址即可（单端点假设见 ADR 0003）。
        private volatile SocketAddress clientAddress;
        private volatile boolean open = true;

        UdpAssociation(DatagramSocket relay) {
            this.relay = relay;
        }

        void relayLoop() {
            byte[] buffer = new byte[UDP_BUFFER_SIZE];
            while (open && running) {
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                try {
                    relay.receive(packet);
                } catch (IOException error) {
                    break;
                }
                clientAddress = packet.getSocketAddress();
                try {
                    forwardToTarget(packet);
                } catch (Exception error) {
                    Log.w(TAG, "UDP relay forward failed.", error);
                }
            }
            close();
        }

        private void forwardToTarget(DatagramPacket packet) throws IOException, InterruptedException {
            byte[] data = packet.getData();
            int length = packet.getLength();
            if (length < 4 || data[2] != 0) {
                // 头部不完整或分片（FRAG != 0），按 RFC 1928 丢弃。
                return;
            }
            int atyp = data[3] & 0xff;
            int offset = 4;
            String host;
            if (atyp == ATYP_IPV4) {
                if (length < offset + 4 + 2) {
                    return;
                }
                host = InetAddress.getByAddress(Arrays.copyOfRange(data, offset, offset + 4)).getHostAddress();
                offset += 4;
            } else if (atyp == ATYP_IPV6) {
                if (length < offset + 16 + 2) {
                    return;
                }
                host = InetAddress.getByAddress(Arrays.copyOfRange(data, offset, offset + 16)).getHostAddress();
                offset += 16;
            } else if (atyp == ATYP_DOMAIN) {
                int domainLength = data[offset] & 0xff;
                offset += 1;
                if (length < offset + domainLength + 2) {
                    return;
                }
                host = new String(data, offset, domainLength, StandardCharsets.UTF_8);
                offset += domainLength;
            } else {
                return;
            }
            int port = ((data[offset] & 0xff) << 8) | (data[offset + 1] & 0xff);
            offset += 2;
            int payloadLength = length - offset;
            if (payloadLength < 0) {
                return;
            }

            // 回包头按 RFC 1928 原样回显客户端请求的 ATYP+ADDR+PORT（含域名形态），
            // 仅在前面补 RSV(2)+FRAG(1)=0。data[3..offset) 即完整的 ATYP+ADDR+PORT 段。
            String flowKey = atyp + "|" + host + "|" + port;
            byte[] responseHeader = new byte[3 + (offset - 3)];
            System.arraycopy(data, 3, responseHeader, 3, offset - 3);

            PacketDecision decision = shaper.decide(PacketDirection.UPLOAD, payloadLength);
            if (decision.drop) {
                return;
            }
            sleep(decision.delayMs);

            UpstreamFlow flow = upstreamFor(flowKey, host, port, responseHeader);
            if (flow == null) {
                return;
            }
            // 目标地址在建流时解析一次并缓存，避免每个上行包都做同步 DNS 阻塞 relayLoop。
            flow.socket.send(new DatagramPacket(data, offset, payloadLength, flow.target, port));
        }

        private UpstreamFlow upstreamFor(String key, String host, int port, byte[] responseHeader) {
            UpstreamFlow existing = flows.get(key);
            if (existing != null) {
                return existing;
            }
            try {
                InetAddress target = InetAddress.getByName(host);
                DatagramSocket socket = new DatagramSocket();
                UpstreamFlow flow = new UpstreamFlow(socket, target, responseHeader);
                UpstreamFlow raced = flows.putIfAbsent(key, flow);
                if (raced != null) {
                    socket.close();
                    return raced;
                }
                executor.execute(() -> targetLoop(flow));
                return flow;
            } catch (IOException error) {
                Log.w(TAG, "Failed to open upstream UDP socket.", error);
                return null;
            }
        }

        private void targetLoop(UpstreamFlow flow) {
            byte[] buffer = new byte[UDP_BUFFER_SIZE];
            while (open && running) {
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                try {
                    flow.socket.receive(packet);
                } catch (IOException error) {
                    break;
                }
                SocketAddress destination = clientAddress;
                if (destination == null) {
                    continue;
                }
                PacketDecision decision = shaper.decide(PacketDirection.DOWNLOAD, packet.getLength());
                if (decision.drop) {
                    continue;
                }
                try {
                    sleep(decision.delayMs);
                    byte[] reply = wrapReply(flow.responseHeader, packet.getData(), packet.getLength());
                    relay.send(new DatagramPacket(reply, reply.length, destination));
                } catch (Exception error) {
                    Log.w(TAG, "UDP relay reply failed.", error);
                }
            }
        }

        private byte[] wrapReply(byte[] header, byte[] payload, int payloadLength) {
            byte[] out = new byte[header.length + payloadLength];
            System.arraycopy(header, 0, out, 0, header.length);
            System.arraycopy(payload, 0, out, header.length, payloadLength);
            return out;
        }

        void close() {
            if (!open) {
                return;
            }
            open = false;
            closeQuietly(relay);
            for (UpstreamFlow flow : flows.values()) {
                flow.socket.close();
            }
            flows.clear();
        }
    }

    private static final class UpstreamFlow {
        final DatagramSocket socket;
        final InetAddress target;
        final byte[] responseHeader;

        UpstreamFlow(DatagramSocket socket, InetAddress target, byte[] responseHeader) {
            this.socket = socket;
            this.target = target;
            this.responseHeader = responseHeader;
        }
    }

    private void negotiate(InputStream input, OutputStream output) throws IOException {
        int version = readByte(input);
        if (version != SOCKS_VERSION) {
            throw new IOException("Unsupported SOCKS version: " + version);
        }
        int methodCount = readByte(input);
        for (int i = 0; i < methodCount; i++) {
            readByte(input);
        }
        output.write(new byte[] { SOCKS_VERSION, 0x00 });
        output.flush();
    }

    private SocksRequest readRequest(InputStream input) throws IOException {
        int version = readByte(input);
        if (version != SOCKS_VERSION) {
            throw new IOException("Unsupported request version: " + version);
        }
        int command = readByte(input);
        readByte(input);
        int addressType = readByte(input);
        String host = readHost(input, addressType);
        int port = (readByte(input) << 8) | readByte(input);
        return new SocksRequest(command, host, port);
    }

    private String readHost(InputStream input, int addressType) throws IOException {
        if (addressType == ATYP_IPV4) {
            byte[] address = readBytes(input, 4);
            return InetAddress.getByAddress(address).getHostAddress();
        }
        if (addressType == ATYP_IPV6) {
            byte[] address = readBytes(input, 16);
            return InetAddress.getByAddress(address).getHostAddress();
        }
        if (addressType == ATYP_DOMAIN) {
            int length = readByte(input);
            return new String(readBytes(input, length), StandardCharsets.UTF_8);
        }
        throw new IOException("Unsupported address type: " + addressType);
    }

    private void writeReply(OutputStream output, int status, String bindHost, int bindPort) throws IOException {
        byte[] host = InetAddress.getByName(bindHost).getAddress();
        output.write(new byte[] {
            SOCKS_VERSION,
            (byte) status,
            0x00,
            ATYP_IPV4,
            host[0],
            host[1],
            host[2],
            host[3],
            (byte) ((bindPort >> 8) & 0xff),
            (byte) (bindPort & 0xff),
        });
        output.flush();
    }

    private static int readByte(InputStream input) throws IOException {
        int value = input.read();
        if (value < 0) {
            throw new EOFException();
        }
        return value & 0xff;
    }

    private static byte[] readBytes(InputStream input, int length) throws IOException {
        byte[] bytes = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = input.read(bytes, offset, length - offset);
            if (read < 0) {
                throw new EOFException();
            }
            offset += read;
        }
        return bytes;
    }

    private static void sleep(long delayMs) throws InterruptedException {
        if (delayMs > 0) {
            Thread.sleep(delayMs);
        }
    }

    private static void closeQuietly(Object closeable) {
        // Socket / ServerSocket / DatagramSocket 均实现 Closeable，统一处理。
        if (!(closeable instanceof Closeable)) {
            return;
        }
        try {
            ((Closeable) closeable).close();
        } catch (IOException ignored) {
        }
    }

    private static final class SocksRequest {
        final int command;
        final String host;
        final int port;

        SocksRequest(int command, String host, int port) {
            this.command = command;
            this.host = host;
            this.port = port;
        }
    }
}
