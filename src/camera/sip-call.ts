import { Logger } from 'homebridge';
import { createRequire } from 'module';
import sip from 'sip';
import sdp from 'sdp';
import { URL } from 'url';

const require = createRequire(import.meta.url);
const sipDigest = require('sip/digest');

interface RtpStreamOptions {
  port: number;
  rtcpPort: number;
  ssrc?: number;
}

export interface RtpOptions {
  audio: RtpStreamOptions;
}

export interface RtpDescription {
  address: string;
  audio: RtpStreamOptions;
}

interface SipOptions {
  to: string;
  from: string;
  address: string;
  server: string;
}

interface UriOptions {
  name?: string;
  uri: string;
  params?: { tag?: string };
}

interface SipHeaders {
  [name: string]:
    | string
    | UriOptions
    | UriOptions[]
    | { seq: number; method: string }
    | number
    | undefined;
  cseq: { seq: number; method: string };
  to: UriOptions;
  from: UriOptions;
  contact?: UriOptions[];
  via?: UriOptions[];
}

interface SipRequest {
  uri: UriOptions | string;
  method: string;
  headers: SipHeaders;
  content?: string;
}

interface SipResponse {
  status: number;
  reason: string;
  headers: SipHeaders;
  content?: string;
}

interface SipStack {
  send: (request: SipRequest | SipResponse, callback?: (response: SipResponse) => void) => void;
  destroy: () => void;
}

function getRandomId() {
  return Math.floor(Math.random() * 1e6).toString();
}

function getRtpDescription(
  log: Logger | null,
  sections: string[],
  mediaType: 'audio',
): RtpStreamOptions {
  try {
    const section = sections.find((s) => s.startsWith('m=' + mediaType));
    if (section === undefined) {
      // noinspection ExceptionCaughtLocallyJS
      throw new Error('No m line found');
    }
    const { port } = sdp.parseMLine(section),
      lines: string[] = sdp.splitLines(section),
      rtcpLine = lines.find((l: string) => l.startsWith('a=rtcp:')),
      ssrcLine = lines.find((l: string) => l.startsWith('a=ssrc'));
    if (port === undefined) {
      // noinspection ExceptionCaughtLocallyJS
      throw new Error('No port found in m line');
    }
    return {
      port,
      rtcpPort: (rtcpLine && Number(rtcpLine.match(/rtcp:(\S*)/)?.[1])) || port + 1, // if there is no explicit RTCP port, then use RTP port + 1
      ssrc: (ssrcLine && Number(ssrcLine.match(/ssrc:(\S*)/)?.[1])) || undefined,
    };
  } catch (e) {
    log?.error('Failed to parse SDP from remote end');
    log?.error(sections.join('\r\n'));
    throw e;
  }
}

function parseRtpDescription(log: Logger | null, inviteResponse: SipResponse): RtpDescription {
  const sections: string[] = sdp.splitSections(inviteResponse.content ?? ''),
    lines: string[] = sdp.splitLines(sections[0]),
    cLine = lines.find((line: string) => line.startsWith('c='))!;

  return {
    address: cLine.match(/c=IN IP4 (\S*)/)![1],
    audio: getRtpDescription(log, sections, 'audio'),
  };
}

export class SipCall {
  private seq = 20;
  private callId = getRandomId();
  private sipStack: SipStack;
  private destroyed = false;
  private readonly log: Logger | null;

  constructor(
    log: Logger | null,
    private sipOptions: SipOptions,
  ) {
    this.log = log;
    const url = new URL(this.sipOptions.server);
    this.sipStack = sip.create(
      {
        address: this.sipOptions.address,

        hostname: url.hostname,
        port: parseInt(url.port) || undefined,

        udp: url.protocol === 'udp:',
        tcp: url.protocol === 'tcp:',
        tls: url.protocol === 'tls:' || url.protocol === 'wss:',
        tls_port: (url.protocol === 'tls:' && parseInt(url.port)) || undefined,
        ws_port: (['ws:', 'wss:'].includes(url.protocol) && parseInt(url.port)) || undefined,

        logger: {
          send: (m, target) => {
            this.log?.debug(sip.stringify(m), target);
          },
          recv: (m, remote) => {
            this.log?.debug(sip.stringify(m), remote);
          },
          error: (e) => {
            this.log?.error(e);
          },
        },
      },
      (request: SipRequest) => {
        if (request.method === 'BYE') {
          this.log?.info('received BYE from remote end');
          this.sipStack.send(sip.makeResponse(request, 200, 'Ok'));
        }
      },
    );
  }

  async invite(rtpOptions: RtpOptions) {
    // As we keep the SIP stack alive, we have to reset call-related properties for each new call
    this.callId = getRandomId();

    const { from } = this.sipOptions;
    const { user, host } = sip.parseUri(from);
    const { audio } = rtpOptions;
    const response = await this.request({
      method: 'INVITE',
      headers: {
        'content-type': 'application/sdp',
        contact: [{ uri: from }],
      },
      content:
        [
          'v=0',
          `o=${user} 3747 461 IN IP4 ${host}`,
          's=Talk',
          `c=IN IP4 ${host}`,
          't=0 0',
          `m=audio ${audio.port} RTP/AVP 0`,
          `a=rtcp:${audio.rtcpPort} IN IP4 ${host}`,
          audio.ssrc ? `a=ssrc:${audio.ssrc}` : null,
          'a=sendrecv',
        ]
          .filter((l) => l)
          .join('\r\n') + '\r\n',
    });
    return parseRtpDescription(this.log, response);
  }

  async sendBye(): Promise<void> {
    try {
      await this.request({ method: 'BYE' });
    } catch (err) {
      // We can ignore failures to send BYE
      this.log?.error('SIP BYE failed:', err);
    }
  }

  private async request(
    {
      method,
      headers,
      content,
      cseq,
    }: {
      method: string;
      headers?: Partial<SipHeaders>;
      content?: string;
      cseq?: number;
    },
    isRetry: boolean = false,
  ): Promise<SipResponse> {
    if (this.destroyed) {
      throw new Error('SIP request made after call was destroyed');
    }
    return this.send(
      {
        method,
        uri: this.sipOptions.to,
        headers: {
          ...headers,
          to: {
            uri: this.sipOptions.to,
          },
          from: {
            uri: this.sipOptions.from,
          },
          'max-forwards': 70,
          'call-id': this.callId,
          cseq: { seq: cseq ?? this.seq++, method },
        },
        content,
      },
      isRetry,
    );
  }

  private async send(request: SipRequest, isRetry: boolean = false): Promise<SipResponse> {
    return new Promise((resolve, reject) => {
      this.sipStack.send(request, (response) => {
        if (response.status >= 100 && response.status < 200) {
          // Interim response
          return;
        } else if (response.status >= 200 && response.status < 300) {
          if (response.headers?.cseq?.method === 'INVITE' && response.headers.cseq.seq) {
            this.sipStack.send({
              method: 'ACK',
              uri: response.headers.contact?.[0]?.uri ?? this.sipOptions.to,
              headers: {
                to: response.headers.to ?? {
                  uri: this.sipOptions.to,
                },
                from: response.headers.from ?? {
                  uri: this.sipOptions.from,
                },
                'call-id': response.headers['call-id'] ?? this.callId,
                cseq: { method: 'ACK', seq: response.headers.cseq.seq },
                via: [],
              },
            });
          }
          resolve(response);
          return;
        } else if (!isRetry && (response.status === 401 || response.status === 407)) {
          const url = new URL(this.sipOptions.server);
          const ctx = sipDigest.signRequest(null, request, response, {
            user: url.username,
            password: url.password,
          });
          this.request(
            {
              ...request,
              headers: {
                ...request.headers,
                ...(ctx.proxy
                  ? {
                      'proxy-authorization': request.headers['proxy-authorization'],
                    }
                  : {
                      authorization: request.headers['authorization'],
                    }),
              },
            },
            true,
          )
            .then(resolve)
            .catch(reject);
        } else {
          reject(
            new Error(
              `sip ${request.method} request failed with status ${response.status} and reason '${response.reason}'`,
            ),
          );
        }
      });
    });
  }

  destroy() {
    this.destroyed = true;
    this.log?.debug('Destroying SIP stack');
    try {
      this.sipStack.destroy();
    } catch (err) {
      this.log?.error('Destroying SIP stack failed:', err);
    }
  }
}
