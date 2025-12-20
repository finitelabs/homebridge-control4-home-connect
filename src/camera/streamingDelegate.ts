import {
  API,
  APIEvent,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  CameraControllerOptions,
  CameraStreamingDelegate,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  SRTPCryptoSuites,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
  StreamRequestTypes,
  VideoInfo,
  Logger,
  PlatformAccessory,
} from 'homebridge';
import { spawn } from 'child_process';
import { createSocket, Socket } from 'dgram';
import ffmpegPath from 'ffmpeg-for-homebridge';
import { FfmpegProcess } from './ffmpeg.js';
import { C4HCHomebridgePlatform, C4HCPlatformAccessoryContext } from '../platform.js';
import { RtpDescription, RtpOptions, SipCall } from './sip-call.js';
import { RtpHelper, RtpPortAllocator } from './rtp.js';
import { loggerWithPrefix } from '../utils.js';

export type CameraConfig = {
  source?: string;
  stillImageSource?: string;
  returnAudioTarget?: string;
  maxStreams?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxFPS?: number;
  maxBitrate?: number;
  forceMax?: boolean;
  vcodec?: string;
  packetSize?: number;
  videoFilter?: string;
  encoderOptions?: string;
  mapvideo?: string;
  mapaudio?: string;
  audio?: boolean;
  debug?: boolean;
  debugReturn?: boolean;
  sipConfig?: SipConfig;
};

export type SipConfig = {
  from: string;
  to: string;
  address: string;
  server: string;
};

type SessionInfo = {
  address: string; // address of the HAP controller
  ipv6: boolean;

  videoPort: number;
  videoReturnPort: number;
  videoCryptoSuite: SRTPCryptoSuites; // should be saved if multiple suites are supported
  videoSRTP: Buffer; // key and salt concatenated
  videoSSRC: number; // rtp synchronisation source

  audioPort: number;
  audioReturnPort: number;
  audioCryptoSuite: SRTPCryptoSuites;
  audioSRTP: Buffer;
  audioSSRC: number;

  sipRtpOptions?: RtpOptions;
  sipRemoteRtpDescription?: RtpDescription;
  rtpHelper?: RtpHelper;
  rtpLocalAudioPort?: number;
  rtpLocalAudioPortRtcp?: number;
};

type ResolutionInfo = {
  width: number;
  height: number;
  videoFilter?: string;
  snapFilter?: string;
  resizeFilter?: string;
};

type ActiveSession = {
  mainProcess?: FfmpegProcess;
  returnProcess?: FfmpegProcess;
  timeout?: NodeJS.Timeout;
  socket?: Socket;
  rtpHelper?: RtpHelper;
};

export class StreamingDelegate implements CameraStreamingDelegate {
  private readonly log: Logger;
  private readonly api: API;
  private readonly platform: C4HCHomebridgePlatform;
  private readonly accessory: PlatformAccessory<C4HCPlatformAccessoryContext>;

  private readonly ffmpegPath: string;
  private readonly cameraConfig: CameraConfig;
  private readonly sipCall?: SipCall;
  readonly controller: CameraController;
  private snapshotPromise?: Promise<Buffer>;

  // keep track of sessions
  pendingSessions: Map<string, SessionInfo> = new Map();
  ongoingSessions: Map<string, ActiveSession> = new Map();

  constructor(
    log: Logger,
    api: API,
    platform: C4HCHomebridgePlatform,
    accessory: PlatformAccessory<C4HCPlatformAccessoryContext>,
  ) {
    // eslint-disable-line @typescript-eslint/explicit-module-boundary-types
    this.log = loggerWithPrefix(log, `[${accessory.displayName}]`);
    this.api = api;
    this.platform = platform;
    this.accessory = accessory;
    this.ffmpegPath = (ffmpegPath as unknown as string) || 'ffmpeg';
    this.cameraConfig = this.accessory.context.definition.options?.camera ?? {};

    this.api.on(APIEvent.SHUTDOWN, () => {
      for (const session in this.ongoingSessions) {
        this.stopStream(session);
      }
      this.sipCall?.destroy();
    });

    const options: CameraControllerOptions = {
      cameraStreamCount: this.cameraConfig.maxStreams ?? 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [this.api.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [320, 180, 30],
            [320, 240, 15], // Apple Watch requires this configuration
            [320, 240, 30],
            [480, 270, 30],
            [480, 360, 30],
            [640, 360, 30],
            [640, 480, 30],
            [1280, 720, 30],
            [1280, 960, 30],
            [1920, 1080, 30],
            [1600, 1200, 30],
          ],
          codec: {
            profiles: [
              this.api.hap.H264Profile.BASELINE,
              this.api.hap.H264Profile.MAIN,
              this.api.hap.H264Profile.HIGH,
            ],
            levels: [
              this.api.hap.H264Level.LEVEL3_1,
              this.api.hap.H264Level.LEVEL3_2,
              this.api.hap.H264Level.LEVEL4_0,
            ],
          },
        },
        audio: this.cameraConfig.audio
          ? {
              twoWayAudio: !!this.cameraConfig.returnAudioTarget || !!this.cameraConfig.sipConfig,
              codecs: [
                {
                  type: AudioStreamingCodecType.AAC_ELD,
                  samplerate: AudioStreamingSamplerate.KHZ_16,
                  // type: AudioStreamingCodecType.OPUS,
                  // samplerate: AudioStreamingSamplerate.KHZ_24,
                },
              ],
            }
          : undefined,
      },
    };
    if (this.cameraConfig.sipConfig) {
      this.sipCall = new SipCall(this.log, this.cameraConfig.sipConfig);
    }

    this.controller = new this.api.hap.CameraController(options);
  }

  private determineResolution(
    request: SnapshotRequest | VideoInfo,
    isSnapshot: boolean,
  ): ResolutionInfo {
    const resInfo: ResolutionInfo = {
      width: request.width,
      height: request.height,
    };
    if (!isSnapshot) {
      if (
        this.cameraConfig.maxWidth !== undefined &&
        (this.cameraConfig.forceMax || request.width > this.cameraConfig.maxWidth)
      ) {
        resInfo.width = this.cameraConfig.maxWidth;
      }
      if (
        this.cameraConfig.maxHeight !== undefined &&
        (this.cameraConfig.forceMax || request.height > this.cameraConfig.maxHeight)
      ) {
        resInfo.height = this.cameraConfig.maxHeight;
      }
    }

    const filters: Array<string> = this.cameraConfig.videoFilter?.split(',') || [];
    const noneFilter = filters.indexOf('none');
    if (noneFilter >= 0) {
      filters.splice(noneFilter, 1);
    }
    resInfo.snapFilter = filters.join(',');
    if (noneFilter < 0 && (resInfo.width > 0 || resInfo.height > 0)) {
      resInfo.resizeFilter =
        'scale=' +
        (resInfo.width > 0 ? "'min(" + resInfo.width + ",iw)'" : 'iw') +
        ':' +
        (resInfo.height > 0 ? "'min(" + resInfo.height + ",ih)'" : 'ih') +
        ':force_original_aspect_ratio=decrease';
      filters.push(resInfo.resizeFilter);
      filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2'); // Force to fit encoder restrictions
    }

    if (filters.length > 0) {
      resInfo.videoFilter = filters.join(',');
    }

    return resInfo;
  }

  fetchSnapshot(snapFilter?: string): Promise<Buffer> {
    this.snapshotPromise = new Promise((resolve, reject) => {
      const startTime = Date.now();
      const ffmpegArgs =
        (this.cameraConfig.stillImageSource || this.cameraConfig.source!) + // Still
        ' -frames:v 1' +
        (snapFilter ? ' -filter:v ' + snapFilter : '') +
        ' -f image2 -' +
        ' -hide_banner' +
        ' -loglevel error';

      this.log.debug('Snapshot command:', this.ffmpegPath, ffmpegArgs);
      const ffmpeg = spawn(this.ffmpegPath, ffmpegArgs.split(/\s+/), { env: process.env });

      let snapshotBuffer = Buffer.alloc(0);
      ffmpeg.stdout.on('data', (data) => {
        snapshotBuffer = Buffer.concat([snapshotBuffer, data]);
      });
      ffmpeg.on('error', (error: Error) => {
        reject('FFmpeg process creation failed: ' + error.message);
      });
      ffmpeg.stderr.on('data', (data) => {
        data
          .toString()
          .split('\n')
          .forEach((line: string) => {
            if (this.cameraConfig.debug && line.length > 0) {
              // For now only write anything out when debug is set
              this.log.error('[Snapshot]', line);
            }
          });
      });
      ffmpeg.on('close', () => {
        if (snapshotBuffer.length > 0) {
          resolve(snapshotBuffer);
        } else {
          reject('Failed to fetch snapshot.');
        }

        setTimeout(() => {
          this.snapshotPromise = undefined;
        }, 3 * 1000); // Expire cached snapshot after 3 seconds

        const runtime = (Date.now() - startTime) / 1000;
        let message = 'Fetching snapshot took ' + runtime + ' seconds.';
        if (runtime < 5) {
          this.log.debug(message);
        } else {
          if (runtime < 22) {
            this.log.warn(message);
          } else {
            message +=
              ' The request has timed out and the snapshot has not been refreshed in HomeKit.';
            this.log.error(message);
          }
        }
      });
    });
    return this.snapshotPromise;
  }

  resizeSnapshot(snapshot: Buffer, resizeFilter?: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const ffmpegArgs =
        '-i pipe:' + // Resize
        ' -frames:v 1' +
        (resizeFilter ? ' -filter:v ' + resizeFilter : '') +
        ' -f image2 -';

      this.log.debug('Resize command:', this.ffmpegPath, ffmpegArgs);
      const ffmpeg = spawn(this.ffmpegPath, ffmpegArgs.split(/\s+/), { env: process.env });

      let resizeBuffer = Buffer.alloc(0);
      ffmpeg.stdout.on('data', (data) => {
        resizeBuffer = Buffer.concat([resizeBuffer, data]);
      });
      ffmpeg.on('error', (error: Error) => {
        reject('FFmpeg process creation failed: ' + error.message);
      });
      ffmpeg.on('close', () => {
        resolve(resizeBuffer);
      });
      ffmpeg.stdin.end(snapshot);
    });
  }

  async handleSnapshotRequest(
    request: SnapshotRequest,
    callback: SnapshotRequestCallback,
  ): Promise<void> {
    const resolution = this.determineResolution(request, true);

    try {
      const cachedSnapshot = !!this.snapshotPromise;

      this.log.debug('Snapshot requested:', request.width, 'x', request.height);

      const snapshot = await (this.snapshotPromise || this.fetchSnapshot(resolution.snapFilter));

      this.log.debug(
        'Sending snapshot:',
        resolution.width > 0 ? resolution.width : 'native',
        'x',
        resolution.height > 0 ? resolution.height : 'native',
        cachedSnapshot ? '(cached)' : '',
      );

      const resized = await this.resizeSnapshot(snapshot, resolution.resizeFilter);
      callback(undefined, resized);
    } catch (err) {
      this.log.error(err as string);
      callback();
    }
  }

  async prepareStream(
    request: PrepareStreamRequest,
    callback: PrepareStreamCallback,
  ): Promise<void> {
    const ipv6 = request.addressVersion === 'ipv6';
    const [videoReturnPort, _, audioReturnPort, __, ...sipAudioPorts] =
      await RtpPortAllocator.reservePorts(
        ipv6 ? 'ipv6' : 'ipv4',
        this.cameraConfig.sipConfig && this.sipCall ? 8 : 4,
      );
    const videoSSRC = this.api.hap.CameraController.generateSynchronisationSource();
    const audioSSRC = this.api.hap.CameraController.generateSynchronisationSource();

    const sessionInfo: SessionInfo = {
      address: request.targetAddress,
      ipv6: ipv6,

      videoPort: request.video.port,
      videoReturnPort: videoReturnPort,
      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
      videoSSRC: videoSSRC,

      audioPort: request.audio.port,
      audioReturnPort: audioReturnPort,
      audioCryptoSuite: request.audio.srtpCryptoSuite,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      audioSSRC: audioSSRC,
    };

    if (this.cameraConfig.sipConfig && this.sipCall) {
      const [
        sipIncomingAudioPort,
        sipIncomingAudioRtcpPort,
        sipLocalAudioPort,
        sipLocalAudioRtcpPort,
      ] = sipAudioPorts;
      const sipAudioSSRC = this.api.hap.CameraController.generateSynchronisationSource();
      sessionInfo.sipRtpOptions = {
        audio: {
          port: sipIncomingAudioPort,
          rtcpPort: sipIncomingAudioRtcpPort,
          ssrc: sipAudioSSRC,
        },
      };
      sessionInfo.rtpLocalAudioPort = sipLocalAudioPort;
      sessionInfo.rtpLocalAudioPortRtcp = sipLocalAudioRtcpPort;

      try {
        const sipRemoteRtpDescription = await this.sipCall.invite({
          audio: {
            port: sipIncomingAudioPort,
            rtcpPort: sipIncomingAudioRtcpPort,
            ssrc: sipAudioSSRC,
          },
        });

        sessionInfo.sipRemoteRtpDescription = sipRemoteRtpDescription;
        sessionInfo.rtpHelper = new RtpHelper(
          this.log,
          'ipv4',
          sipIncomingAudioPort,
          sipIncomingAudioRtcpPort,
          sipLocalAudioPort,
          sipLocalAudioRtcpPort,
          sipRemoteRtpDescription.address,
          sipRemoteRtpDescription.audio.port,
          sipRemoteRtpDescription.audio.rtcpPort,
        );
      } catch (err) {
        this.sipCall.sendBye().catch();
        this.log.error('SIP INVITE failed:', err);
      }
    }

    const response: PrepareStreamResponse = {
      video: {
        port: videoReturnPort,
        ssrc: videoSSRC,

        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
      audio: this.cameraConfig.audio
        ? {
            port: audioReturnPort,
            ssrc: audioSSRC,

            srtp_key: request.audio.srtp_key,
            srtp_salt: request.audio.srtp_salt,
          }
        : undefined,
    };

    this.pendingSessions.set(request.sessionID, sessionInfo);
    callback(undefined, response);
  }

  private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {
    const sessionInfo = this.pendingSessions.get(request.sessionID);
    if (sessionInfo) {
      const vcodec = this.cameraConfig.vcodec || 'libx264';
      const mtu = this.cameraConfig.packetSize || 1316; // request.video.mtu is not used
      let encoderOptions = this.cameraConfig.encoderOptions;
      if (!encoderOptions && vcodec === 'libx264') {
        encoderOptions = '-preset ultrafast -tune zerolatency';
      }

      const resolution = this.determineResolution(request.video, false);

      let fps =
        this.cameraConfig.maxFPS !== undefined &&
        (this.cameraConfig.forceMax || request.video.fps > this.cameraConfig.maxFPS)
          ? this.cameraConfig.maxFPS
          : request.video.fps;
      let videoBitrate =
        this.cameraConfig.maxBitrate !== undefined &&
        (this.cameraConfig.forceMax || request.video.max_bit_rate > this.cameraConfig.maxBitrate)
          ? this.cameraConfig.maxBitrate
          : request.video.max_bit_rate;

      if (vcodec === 'copy') {
        resolution.width = 0;
        resolution.height = 0;
        resolution.videoFilter = undefined;
        fps = 0;
        videoBitrate = 0;
      }

      this.log.debug(
        'Video stream requested:',
        request.video.width,
        'x',
        request.video.height,
        ',',
        request.video.fps,
        'fps,',
        request.video.max_bit_rate,
        'kbps',
      );
      this.log.info(
        'Starting video stream:',
        resolution.width > 0 ? resolution.width : 'native',
        'x',
        resolution.height > 0 ? resolution.height : 'native',
        ',',
        fps > 0 ? fps : 'native',
        'fps,',
        videoBitrate > 0 ? videoBitrate : '???',
        'kbps',
        this.cameraConfig.audio ? ' (' + request.audio.codec + ')' : '',
      );

      let ffmpegArgs = this.cameraConfig.source!;
      if (this.cameraConfig.sipConfig) {
        ffmpegArgs += // SIP audio via RTP
          ' -hide_banner' +
          ' -protocol_whitelist pipe,udp,rtp,file,crypto' +
          ' -f sdp' +
          ' -c:a pcm_mulaw' +
          ' -i pipe:';
      }

      ffmpegArgs += // Video
        (this.cameraConfig.mapvideo ? ' -map ' + this.cameraConfig.mapvideo : ' -an -sn -dn') +
        ' -codec:v ' +
        vcodec +
        ' -pix_fmt yuv420p' +
        ' -color_range mpeg' +
        (fps > 0 ? ' -r ' + fps : '') +
        ' -f rawvideo' +
        (encoderOptions ? ' ' + encoderOptions : '') +
        (resolution.videoFilter ? ' -filter:v ' + resolution.videoFilter : '') +
        (videoBitrate > 0 ? ' -b:v ' + videoBitrate + 'k' : '') +
        ' -payload_type ' +
        request.video.pt;

      ffmpegArgs += // Video Stream
        ' -ssrc ' +
        sessionInfo.videoSSRC +
        ' -f rtp' +
        ' -srtp_out_suite AES_CM_128_HMAC_SHA1_80' +
        ' -srtp_out_params ' +
        sessionInfo.videoSRTP.toString('base64') +
        ' srtp://' +
        sessionInfo.address +
        ':' +
        sessionInfo.videoPort +
        '?rtcpport=' +
        sessionInfo.videoPort +
        '&pkt_size=' +
        mtu;

      if (this.cameraConfig.audio) {
        if (
          request.audio.codec === AudioStreamingCodecType.OPUS ||
          request.audio.codec === AudioStreamingCodecType.AAC_ELD
        ) {
          ffmpegArgs += // Audio
            (this.cameraConfig.mapaudio ? ' -map ' + this.cameraConfig.mapaudio : ' -vn -sn -dn') +
            (request.audio.codec === AudioStreamingCodecType.OPUS
              ? ' -codec:a libopus -application lowdelay'
              : ' -codec:a libfdk_aac -profile:a aac_eld') +
            ' -flags +global_header' +
            ' -f null' +
            ' -ar ' +
            request.audio.sample_rate +
            'k' +
            ' -b:a ' +
            request.audio.max_bit_rate +
            'k' +
            ' -ac ' +
            request.audio.channel +
            ' -payload_type ' +
            request.audio.pt;

          ffmpegArgs += // Audio Stream
            ' -ssrc ' +
            sessionInfo.audioSSRC +
            ' -f rtp' +
            ' -srtp_out_suite AES_CM_128_HMAC_SHA1_80' +
            ' -srtp_out_params ' +
            sessionInfo.audioSRTP.toString('base64') +
            ' srtp://' +
            sessionInfo.address +
            ':' +
            sessionInfo.audioPort +
            '?rtcpport=' +
            sessionInfo.audioPort +
            '&pkt_size=188';
        } else {
          this.log.error('Unsupported audio codec requested:', request.audio.codec);
        }
      }

      ffmpegArgs +=
        ' -loglevel level' + (this.cameraConfig.debug ? '+verbose' : '') + ' -progress pipe:1';

      const activeSession: ActiveSession = {};

      activeSession.socket = createSocket(sessionInfo.ipv6 ? 'udp6' : 'udp4');
      activeSession.socket.on('error', (err: Error) => {
        this.log.error('Socket error:', err.message);
        this.stopStream(request.sessionID);
      });
      activeSession.socket.on('message', () => {
        if (activeSession.timeout) {
          clearTimeout(activeSession.timeout);
        }
        activeSession.timeout = setTimeout(
          () => {
            this.log.info('Device appears to be inactive; stopping stream');
            this.controller.forceStopStreamingSession(request.sessionID);
            this.stopStream(request.sessionID);
          },
          request.video.rtcp_interval * 5 * 1000,
        );
      });
      activeSession.socket.bind(sessionInfo.videoReturnPort);

      if (
        this.cameraConfig.sipConfig &&
        sessionInfo.sipRemoteRtpDescription &&
        sessionInfo.sipRtpOptions
      ) {
        // If we use SIP we set up the returnAudioTarget ourselves
        this.cameraConfig.returnAudioTarget =
          ' -acodec pcm_mulaw' +
          ' -ac 1' +
          ' -ar 8k' +
          ' -f rtp' +
          //(sessionInfo.sipRemoteRtpDescription.audio.ssrc ? ' -ssrc ' +
          // sessionInfo.sipRemoteRtpDescription.audio.ssrc : '') +
          // see ffmpeg bug: https://trac.ffmpeg.org/ticket/9080
          ' -payload_type 0' +
          ' rtp://127.0.0.1:' +
          sessionInfo.sipRtpOptions.audio.port +
          '?rtcpport=' +
          sessionInfo.sipRtpOptions.audio.rtcpPort;
      }

      activeSession.mainProcess = new FfmpegProcess(
        request.sessionID,
        this.ffmpegPath,
        ffmpegArgs,
        loggerWithPrefix(this.log, '[Main]'),
        this.cameraConfig.debug,
        this,
        callback,
      );

      if (this.cameraConfig.sipConfig) {
        const sdpAudio =
          'v=0\r\n' +
          'o=- 0 0 IN IP4 127.0.0.1\r\n' +
          's=Talk\r\n' +
          'c=IN IP4 127.0.0.1\r\n' +
          't=0 0\r\n' +
          'm=audio ' +
          sessionInfo.rtpLocalAudioPort +
          ' RTP/AVP 0\r\n' +
          'a=rtpmap:0 PCMU/8000\r\n';
        activeSession.mainProcess.stdin.end(sdpAudio);
      }

      if (this.cameraConfig.returnAudioTarget) {
        const ffmpegReturnArgs =
          '-hide_banner' +
          ' -protocol_whitelist pipe,udp,rtp,file,crypto' +
          ' -f sdp' +
          ' -c:a libfdk_aac' +
          ' -i pipe:' +
          ' ' +
          this.cameraConfig.returnAudioTarget +
          ' -loglevel level' +
          (this.cameraConfig.debugReturn ? '+verbose' : '');

        const ipVer = sessionInfo.ipv6 ? 'IP6' : 'IP4';

        const sdpReturnAudio =
          'v=0\r\n' +
          'o=- 0 0 IN ' +
          ipVer +
          ' ' +
          sessionInfo.address +
          '\r\n' +
          's=Talk\r\n' +
          'c=IN ' +
          ipVer +
          ' ' +
          sessionInfo.address +
          '\r\n' +
          't=0 0\r\n' +
          'm=audio ' +
          sessionInfo.audioReturnPort +
          ' RTP/AVP 110\r\n' +
          'b=AS:24\r\n' +
          'a=rtpmap:110 MPEG4-GENERIC/16000/1\r\n' +
          'a=rtcp-mux\r\n' + // FFmpeg ignores this, but might as well
          'a=fmtp:110 ' +
          'profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; ' +
          'config=F8F0212C00BC00\r\n' +
          'a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:' +
          sessionInfo.audioSRTP.toString('base64') +
          '\r\n';
        activeSession.returnProcess = new FfmpegProcess(
          request.sessionID,
          this.ffmpegPath,
          ffmpegReturnArgs,
          loggerWithPrefix(this.log, '[Two-way]'),
          this.cameraConfig.debugReturn,
          this,
        );
        activeSession.returnProcess.stdin.end(sdpReturnAudio);
      }

      activeSession.rtpHelper = sessionInfo.rtpHelper;

      this.ongoingSessions.set(request.sessionID, activeSession);
      this.pendingSessions.delete(request.sessionID);
    } else {
      this.log.error('Error finding session information');
      callback(new Error('Error finding session information'));
    }
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case StreamRequestTypes.START:
        this.startStream(request, callback);
        break;
      case StreamRequestTypes.RECONFIGURE:
        this.log.debug(
          'Received request to reconfigure:',
          request.video.width,
          'x',
          request.video.height,
          ',',
          request.video.fps,
          'fps,',
          request.video.max_bit_rate,
          'kbps (Ignored)',
        );
        callback();
        break;
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  public stopStream(sessionId: string): void {
    const session = this.ongoingSessions.get(sessionId);
    if (session) {
      if (session.timeout) {
        clearTimeout(session.timeout);
      }
      try {
        session.socket?.close();
      } catch (err) {
        this.log.error('Error occurred closing socket:', err);
      }
      try {
        session.mainProcess?.stop();
      } catch (err) {
        this.log.error('Error occurred terminating main FFmpeg process:', err);
      }
      try {
        session.returnProcess?.stop();
      } catch (err) {
        this.log.error('Error occurred terminating two-way FFmpeg process:', err);
      }
      this.sipCall?.sendBye();
      session.rtpHelper?.close();
    }
    this.ongoingSessions.delete(sessionId);
    this.log.info('Stopped video stream');
  }
}
