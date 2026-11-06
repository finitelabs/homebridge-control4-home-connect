import { once } from 'node:events';
import { Logger } from 'homebridge';
import { createSocket, RemoteInfo, Socket } from 'dgram';

export class RtpHelper {
  private readonly log: Logger;
  private readonly inputPort: number;
  private readonly inputRtcpPort: number;
  public readonly rtpSocket: Socket;
  public readonly rtcpSocket?: Socket;

  // Create an instance of RtpHelper.
  constructor(
    log: Logger,
    ipFamily: 'ipv4' | 'ipv6',
    inputPort: number,
    inputRtcpPort: number,
    rtcpPort: number,
    rtpPort: number,
    sendAddress: string,
    sendPort: number,
    sendRtcpPort: number,
  ) {
    this.log = log;
    this.inputPort = inputPort;
    this.inputRtcpPort = inputRtcpPort;
    this.rtpSocket = createSocket(ipFamily === 'ipv6' ? 'udp6' : 'udp4');
    this.rtcpSocket =
      inputPort !== inputRtcpPort ? createSocket(ipFamily === 'ipv6' ? 'udp6' : 'udp4') : undefined;

    // Catch errors when they happen on our demuxer.
    this.rtpSocket.on('error', (error) => {
      this.log.error('RtpHelper (RTP) Error:', error);
      this.rtpSocket.close();
    });

    // Catch errors when they happen on our demuxer.
    this.rtcpSocket?.on('error', (error) => {
      this.log.error('RtpHelper (RTCP) Error:', error);
      this.rtcpSocket?.close();
    });

    // Split the message into RTP and RTCP packets.
    this.rtpSocket.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
      // Check if we have to forward a packet from ffmpeg to the external peer
      if (rinfo.address === '127.0.0.1') {
        this.rtpSocket.send(msg, sendPort, sendAddress);
        return;
      }

      // Send RTP packets to the RTP port.
      if (this.isRtpMessage(msg)) {
        this.rtpSocket.send(msg, rtpPort);
      } else {
        this.rtpSocket.send(msg, rtcpPort);
      }
    });

    // Split the message into RTP and RTCP packets.
    this.rtcpSocket?.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
      // Check if we have to forward a packet from ffmpeg to the external peer
      if (rinfo.address === '127.0.0.1') {
        this.rtcpSocket?.send(msg, sendRtcpPort, sendAddress);
        return;
      }

      // Send RTP packets to the RTP port.
      if (this.isRtpMessage(msg)) {
        this.rtcpSocket?.send(msg, rtpPort);
      } else {
        this.rtcpSocket?.send(msg, rtcpPort);
      }
    });

    this.log.debug(
      'Creating RtpHelper instance - inbound port:',
      this.inputPort,
      ', RTCP port:',
      rtcpPort,
      ', RTP port:',
      rtpPort,
    );

    // Take the socket live.
    this.rtpSocket.bind(this.inputPort);
    this.rtcpSocket?.bind(this.inputRtcpPort);
  }

  // Close the socket and cleanup.
  public close(): void {
    this.log.debug('Closing RtpHelper instance on port:', this.inputPort);

    this.rtpSocket.close();
    this.rtcpSocket?.close();
  }

  // Retrieve the payload information from a packet to discern what the packet payload is.
  private getPayloadType(message: Buffer): number {
    return message.readUInt8(1) & 0x7f;
  }

  // Return whether a packet is RTP.
  private isRtpMessage(message: Buffer): boolean {
    const payloadType = this.getPayloadType(message);

    return payloadType > 90 || payloadType === 0;
  }
}

/* RTP port allocator class that keeps track of UDP ports that are currently earmarked for use. We
 * need this when allocating ports that we use for various network activities such as demuxing
 * FFmpeg or opening up other sockets. Otherwise, we run a risk (especially in environment where
 * there are many such requests) of allocating the same port multiple times and end up error'ing out
 * unceremoniously.
 */
export class RtpPortAllocator {
  // Find an available UDP port by binding to one to validate it's availability.
  private static async getPort(ipFamily: string, port = 0): Promise<number> {
    try {
      // Keep looping until we find what we're looking for: local UDP ports that are unspoken for.
      for (;;) {
        // Create a datagram socket, so we can use it to find a port.
        const socket = createSocket(ipFamily === 'ipv6' ? 'udp6' : 'udp4');

        // Exclude this socket from Node's reference counting so we don't have issues later.
        socket.unref();

        // Listen for the bind event.
        const eventListener = once(socket, 'listening');

        // Bind to the port in question. If port is set to 0, we'll get a randomly generated port
        // generated for us.
        socket.bind(port);

        // Ensure we wait for the socket to be bound.
        await eventListener;

        // Retrieve the port number we've gotten from the bind request.
        const assignedPort = socket.address().port;

        // We're done with the socket, lets cleanup.
        socket.close();

        // Return the port.
        return assignedPort;
      }
    } catch {
      return -1;
    }
  }

  // Reserve consecutive ports for use with FFmpeg. FFmpeg currently lacks the ability to specify
  // both the RTP and RTCP ports. FFmpeg always assumes, by convention, that when you specify an RTP
  // port, the RTCP port is the RTP port + 1. In order to work around that challenge, we need to
  // always ensure that when we reserve multiple ports for RTP (primarily for two-way audio) that we
  // are reserving consecutive ports only.
  public static async reservePorts(
    ipFamily: 'ipv4' | 'ipv6' = 'ipv4',
    portCount: number = 1,
    attempts = 0,
  ): Promise<number[]> {
    // Sanity check and make sure we have not exceeded our attempt limit.
    if (attempts > 100) {
      throw new Error(`failed to allocate ${portCount} ${ipFamily} port(s)`);
    }

    const ports: number[] = [];

    // Find the appropriate number of ports being requested.
    while (ports.length !== portCount) {
      const assignedPort = await this.getPort(
        ipFamily,
        ports.length > 0 ? ports[ports.length - 1] + 1 : 0,
      );

      // We haven't gotten a port or our first port is an odd number, let's try again.
      // We need to start on an even number because RTCP ports are the first odd number
      // after the rtp port as per the spec.
      if (assignedPort === -1 || (ports.length === 0 && assignedPort % 2 === 1)) {
        // We still haven't found what we're looking for...keep looking.
        return this.reservePorts(ipFamily, portCount, attempts + 1);
      }
      ports.push(assignedPort);
    }

    // Return the first port we've found.
    return ports;
  }
}
