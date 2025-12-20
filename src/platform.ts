import {
  AdaptiveLightingController,
  API,
  APIEvent,
  Characteristic,
  CharacteristicValue,
  HAPStatus,
  DynamicPlatformPlugin,
  HapStatusError,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  CharacteristicProps,
  UnknownContext,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { WebSocket, WebSocketServer } from 'ws';
import basicAuth from 'basic-auth';
import createCert from 'create-cert';
import http from 'http';
import https from 'https';
import { CameraConfig, StreamingDelegate } from './camera/streamingDelegate.js';
import { FfmpegCodecs } from './camera/ffmpeg-codecs.js';

export type C4HCHomebridgePlatformConfig = PlatformConfig & {
  port: number;
  ssl?: boolean;
  auth?: { username: string; password: string };
};

type C4HCIncomingMessage =
  | {
      topic: 'set-request';
      payload: C4HCSetRequestPayload;
    }
  | {
      topic: 'get-request';
      payload: C4HCGetRequestPayload;
    }
  | {
      topic: 'add-request';
      payload: C4HCAddRequestPayload;
    }
  | {
      topic: 'remove-request';
      payload: C4HCRemoveRequestPayload;
    }
  | {
      topic: 'camera-support-request';
      payload: C4HCCameraSupportRequest;
    }
  | {
      topic: string;
      payload: never;
    };

interface C4HCCommonPayload {
  uuid: string;
}

type C4HCSetRequestPayload = C4HCCommonPayload & {
  name: string;
  service: string;
  characteristic: string;
  value: CharacteristicValue;
  identifier?: CharacteristicValue | null;
  serviceLabelIndex?: CharacteristicValue | null;
};

type C4HCGetRequestPayload = C4HCCommonPayload & {
  simple?: boolean;
};

/**
 * Accessory definitions
 */
type C4HCAccessoryDefinition = {
  uuid: string;
  name: string;
  category?: number;
  external?: boolean;
  services: C4HCServicesDefinition;
  options?: {
    defaultOnBrightness?: number;
    camera?: CameraConfig;
  };
};

type C4HCServicesDefinition = {
  [serviceName: string]: 'default' | C4HCServiceDefinition | C4HCServiceDefinition[];
};

type C4HCServiceDefinition = {
  primary?: boolean;
  characteristics: C4HCCharacteristicsDefinition;
  linkedServices?: Exclude<C4HCServicesDefinition, 'linkedServices'>[];
};

type C4HCCharacteristicsDefinition = {
  [name: Exclude<string, 'value' | 'props'>]:
    | 'default'
    | CharacteristicValue
    | C4HCCharacteristicDefinition;
};

type C4HCCharacteristicDefinition = {
  value?: CharacteristicValue;
  props?: CharacteristicProps;
};

export interface C4HCPlatformAccessoryContext {
  definition: C4HCAccessoryDefinition;
}

type C4HCAddRequestPayload = C4HCCommonPayload & C4HCAccessoryDefinition;

type C4HCRemoveRequestPayload = C4HCCommonPayload;

type C4HCCameraSupportRequest =
  | {
      codecs?: string[];
    }
  | 'default';

type C4HCCameraSupportResponse = {
  codecs: { [index: string]: { decoders: string[]; encoders: string[] } };
};

interface C4HCResponsePayload<T> {
  ack: boolean;
  message: string;
  response: T;
}

type C4HCOutgoingMessage =
  | {
      topic: 'response';
      payload: C4HCResponsePayload<never>;
    }
  | {
      topic: 'add-response';
      payload: C4HCResponsePayload<C4HCAccessoryDefinition>;
    }
  | {
      topic: 'remove-response';
      payload: C4HCResponsePayload<C4HCRemoveRequestPayload | null>;
    }
  | {
      topic: 'get-response';
      payload: C4HCResponsePayload<{
        [uuid: string]: C4HCAccessoryDefinition | string;
      }>;
    }
  | {
      topic: 'set-response';
      payload: C4HCResponsePayload<C4HCSetRequestPayload>;
    }
  | {
      topic: 'set-request';
      payload: C4HCSetRequestPayload;
    }
  | {
      topic: 'camera-support-response';
      payload: C4HCResponsePayload<C4HCCameraSupportResponse>;
    };

const CAMERA_SERVICE_NAMES = [
  'CameraOperatingMode',
  'CameraRecordingManagement',
  'CameraRTPStreamManagement',
  'DataStreamTransportManagement',
  'Microphone',
  'Speaker',
];

const ADAPTIVE_LIGHTING_CHARACTERISTIC_NAMES = [
  'SupportedCharacteristicValueTransitionConfiguration',
  'CharacteristicValueTransitionControl',
  'CharacteristicValueActiveTransitionCount',
];

export class C4HCHomebridgePlatform implements DynamicPlatformPlugin {
  private readonly Service: typeof Service;
  private readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  private readonly accessories: Map<string, PlatformAccessory<C4HCPlatformAccessoryContext>> =
    new Map();

  private readonly characteristicValueCache: Map<string, CharacteristicValue | HapStatusError> =
    new Map();

  private readonly ignoreNextFullBrightness: Map<string, boolean> = new Map();

  private readonly adaptiveLightingControllers: Map<string, AdaptiveLightingController> = new Map();
  private readonly cameraStreamingDelegates: Map<string, StreamingDelegate> = new Map();

  private readonly config: C4HCHomebridgePlatformConfig;
  private readonly ffmpegCodecs: FfmpegCodecs;
  private wsConnection: WebSocket | null = null;

  constructor(
    private readonly log: Logger,
    private readonly platformConfig: PlatformConfig,
    private readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.config = <C4HCHomebridgePlatformConfig>this.platformConfig;
    this.ffmpegCodecs = new FfmpegCodecs(this.log);
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, async () => this.startup());
  }

  configureAccessory(accessory: PlatformAccessory<UnknownContext>) {
    const typedAccessory = accessory as PlatformAccessory<C4HCPlatformAccessoryContext>;
    this.log.info('Loading accessory from cache:', typedAccessory.displayName);
    this.accessories.set(typedAccessory.UUID, typedAccessory);
    this.addAccessory(typedAccessory.context.definition);
  }

  async startup() {
    const server = this.config.ssl ? https.createServer(await this.getCert()) : http.createServer();
    const wss = new WebSocketServer({
      server,
      verifyClient: ({ req }) => {
        // Skip authentication if it is not configured
        if (!this.config.auth?.username || !this.config.auth?.password) {
          return true;
        }

        try {
          const auth = basicAuth(req);
          if (
            auth?.name === this.config.auth.username &&
            auth?.pass === this.config.auth.password
          ) {
            return true;
          }
        } catch {
          /* capture any failures parsing auth header and fall through */
        }
        this.log.error('Authentication failed; refusing connection');
        return false;
      },
    });
    wss.on('connection', (ws, req) => {
      this.wsConnection = ws;
      this.wsConnection.on('message', async (data) => {
        if (!data) {
          return;
        }
        this.log.debug('receive: %s', data);
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          // Invalid message is handled below
        }
        if (!message?.topic || !message?.payload) {
          this.log.warn("received invalid message '%s'", data.toString());
          return;
        }
        this.send(await this.onMessage(<C4HCIncomingMessage>message));
      });
      this.wsConnection.on('close', () => {
        this.log.info('client ip %s disconnected', req.socket.remoteAddress);
        this.characteristicValueCache.clear();
      });
      this.wsConnection.on('error', (e) => {
        this.log.error('websocket error: %s', e.message);
      });
      this.log.info('client ip %s connected', req.socket.remoteAddress);
    });
    server.listen(this.config.port);
  }

  async getCert(): Promise<createCert.CertificateData> {
    try {
      return await createCert();
    } catch {
      this.log.warn(
        'Failed to generate custom SSL cert; falling back to insecure default certificate',
      );
      return {
        key:
          '-----BEGIN RSA PRIVATE KEY-----\n' +
          'MIIEowIBAAKCAQEA2xaJRlhVuDMHyXQkedpjg2pPBrh14S8OfPGBB3a0S5DtycYd\n' +
          'pKgYcIx2jtiULcLku8gayh9U4h8n5pqdBjdH3nA6VV1ICMvv7eMOxSgw6z9IZqcj\n' +
          'ulQVAvIXIArVSLLRyyFQjMwiyWFm4Kdqj7ye8MNbNVxSP1sF0yrzCO+xD1Piq0la\n' +
          'G1mzmVjX7pT8NHseWa2wuXuzCrFvDgF3ACWQoBtWS5zmXVfyDRsPcUHQSTZQHql1\n' +
          'vQ9v5ISH2KZbZm/P0CP2odYHFqR3ojLy81YVQ4kSivMtNN/XqMRNRGH68wUG1wHS\n' +
          'hyh6tha+zNXU7f6oCPZvcNBJQZpBdyVs+1Kt2wIDAQABAoIBAGaw4QZKeF9e9/rq\n' +
          'yAAfp75c0Y7eXk5+7oUM9ARKFQdIdtS5WoKn0dDLXfTlukray7ji+f+cgP5+SQcT\n' +
          'mJ9lwPeX1hfWIeIRqTPxViZ+iLNzlZ2cISiAqdqYG9PGkCNDwgc65dUhB/spfv21\n' +
          'K0MVT9CdWP6hd+G/afMJciJRq0X5lz5S+sKZD5Xt2pMOJFP3m1Z/FevRoZZDm5hs\n' +
          'LS9yDNZwZYh6MsaEXwG2LmLkfgHsuvIMfobu6j38bIaeOfNDUMUS1t0V+s0uWjbM\n' +
          'i1CfMRoNCAi6FSh1kB7d6+qdNp0Rg5jgCaXbx5D2Doh82K746YGencryyS4TC2Q6\n' +
          'TgdB9P0CgYEA8JjNTr4wtzOmGwwryOEwLQGj7qTWstwmhJKA6koQ2OtsDdps+kHq\n' +
          'hN7sw2VgHKaCEbFfvUWVP03G80wKQpgOF/F8iKWTOosgQ/jGo0u8/jVHxSU+xeDp\n' +
          '8+qGY0Wt1s7Ssz7naARHZo6jzIoWMmwhnfQyr2EmYd0e5uQLe/01VvUCgYEA6R04\n' +
          'gL1lPMJB4//k10DXprfzp1A/O+kc1SO0NJfrTgz8r957dhyxZXIsnOIRcC3FeZX3\n' +
          'KFblo7DsfJOv6fmNbJziG6cf74ytfO9Zbyz4nAoQ90dG+WfUmY6H5PtdbCv2awZ/\n' +
          'xmVQ3S23B2P8Cl0l+fjDI3DEjMj7EIKpUSv7z48CgYBmk27sxG92nAGUhILiWQe2\n' +
          'GH3wz7xtcyjE2sU1njBCm1RtL5PIunOnBHgC8mSgsmi/7FR6GIGCBMHulpvFOpi/\n' +
          'oohKpfT4P7qY4CaoFjFUXBjmN3Pk33g/Mtzq1BlCfNkd7JKyKSjb07KIENNX2fwX\n' +
          'ILa/SPcZQDHdlJpE2XZ1RQKBgAMjI4mIAv7IVn6tCPVkqAJUY3ETAWbbAkpUCq7S\n' +
          'hJYuUpBDXEIArNqCqNsLp9RsqUWzoPnoAXssfGJI0otBkoetrNVWcHWW3RbbWcbH\n' +
          'QilHcWcCjI/6t7/BTU7lmyJDjTNviPSwlGAFp3rv+4pgKoysrmOhtuN2KPrV51Vy\n' +
          'VBc9AoGBALC1+iO/hu7Ees0PwfmHd2lhHGDjG7y/+Mds/y6W2ThL9TrvnOF8HYiF\n' +
          'M91o/IgBR3HrRf7sdzV7GNW7SBNDyp7cIzjqkHVIAlXVUOPMe/iNO5JHuisX4RuZ\n' +
          'rnR4iNSEk7C8n+qIS5yc6WINhellI2OfSRTzB5hrYwXDt++J0tuZ\n' +
          '-----END RSA PRIVATE KEY-----',
        cert:
          '-----BEGIN CERTIFICATE-----\n' +
          'MIIC7DCCAdSgAwIBAgIGAY2pOrt6MA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNVBAMM\n' +
          'CWxvY2FsaG9zdDAeFw0yNDAyMTQyMDA2NTVaFw0yNTAyMTMyMDA2NTVaMBYxFDAS\n' +
          'BgNVBAMMC2V4YW1wbGUuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC\n' +
          'AQEA2xaJRlhVuDMHyXQkedpjg2pPBrh14S8OfPGBB3a0S5DtycYdpKgYcIx2jtiU\n' +
          'LcLku8gayh9U4h8n5pqdBjdH3nA6VV1ICMvv7eMOxSgw6z9IZqcjulQVAvIXIArV\n' +
          'SLLRyyFQjMwiyWFm4Kdqj7ye8MNbNVxSP1sF0yrzCO+xD1Piq0laG1mzmVjX7pT8\n' +
          'NHseWa2wuXuzCrFvDgF3ACWQoBtWS5zmXVfyDRsPcUHQSTZQHql1vQ9v5ISH2KZb\n' +
          'Zm/P0CP2odYHFqR3ojLy81YVQ4kSivMtNN/XqMRNRGH68wUG1wHShyh6tha+zNXU\n' +
          '7f6oCPZvcNBJQZpBdyVs+1Kt2wIDAQABo0IwQDAdBgNVHQ4EFgQUZCKdmCsYuTKt\n' +
          'PLka3vYgKCG/7z4wHwYDVR0jBBgwFoAUUUGRhGpWwgA6CF/TYt44s75Op7EwDQYJ\n' +
          'KoZIhvcNAQELBQADggEBALrWjqJLaojzekwoIKtlUTugkis7Fq094QmRLZapJtyC\n' +
          'Dtk2mDwBZY0Ofjg/Hbl8yRNEZDVltHL55ltsWmEjBDbCWgElGDSA3Qlu8I0X5m6E\n' +
          '4jnJzn8PfwMmZaGHMbc0kPLLYe1hRs97IqQUVdfG4+Q3BXSAke//u5CCtxL3upIj\n' +
          'NERhQFvZz6vD6umW48RUR9efJ8U5rA1KI1F0d2/OoGAZp/rpdwRoQO9LmZioiWjQ\n' +
          'BjJklKO43EkkBxG03PbLHO5vuY9zDkI2wEW2WELzP9CZQE7eg5EeYHWnYjK+ZpJ8\n' +
          'Bl1srF2/qBLS6VIvip4Yd1A5H4GK7nGWSTsMSTVYM5U=\n' +
          '-----END CERTIFICATE-----',
        caCert:
          '-----BEGIN CERTIFICATE-----\n' +
          'MIIC1zCCAb+gAwIBAgIUQp8BFTcl7IYkC7T3VkihA0m4dXswDQYJKoZIhvcNAQEL\n' +
          'BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI0MDIxNDIwMDY1NVoXDTI1MDIx\n' +
          'MzIwMDY1NVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF\n' +
          'AAOCAQ8AMIIBCgKCAQEAzV8RHL+07wslEaN6BQ1Hx7UY4jKAL3WbUCqWa5ES+TGe\n' +
          'PbN7MsxumDgLvSkzz+buBaeqLJryfc9JwFD84rthw0fMFVtNoRBjs4GbtNv5080y\n' +
          'iStajW9c7HT1JcVdPGPewwZOZXOgo9KWhZSHcLNbqmhuCLh6H9RkEUybKvNqd6Qj\n' +
          'zmxVQ33ApqtKRjuaIpu2qCqHZMwsr1ONLfvAjWMGMzSV+i0DDX8tC12zAhvuBLHM\n' +
          'z/rRxpSr+SFVIAJsjF4anweKSfKRLXjXEMCNPRf5OgmvJBX2DeJ4bEHqrvxMr7xE\n' +
          'nBhm/m0B1EDZT2hjS12/qD7ym9f8zL4HI3Qd9fWN1QIDAQABoyEwHzAdBgNVHQ4E\n' +
          'FgQUUUGRhGpWwgA6CF/TYt44s75Op7EwDQYJKoZIhvcNAQELBQADggEBAB5JhLwg\n' +
          'RBNgnZtMlPW+CU6iALIyYoFqsoLFtt78P/vR4l4wTW4weEJu2AeHXQZab++sx0Dv\n' +
          'XZmLAhiYvMTpkkHd2sdXHZFms84Q8KLOwhRZSIISqqy+UAecDLiCzQQ+EVe3t8dp\n' +
          '+nVicypwWiWn7aK8Y0wfKA1xrn63xD74pqrZfZXSbZ9WZM+X5fdzJugppTds83oL\n' +
          'vGDvcSD6PhQ6/fjI0H/oZKtdLIQn7g+txfDXP51jShoNVxojEPuAPaJv9XB3VYDz\n' +
          '6GluakpUlJPbUMohOBpbP69W02gf/84Dp0/u/cXJ6+mp/XTyWXIWJejBIn2Q+ckw\n' +
          'O2LTrcFfhUZ7P58=\n' +
          '-----END CERTIFICATE-----',
      };
    }
  }

  async onMessage(message: C4HCIncomingMessage): Promise<C4HCOutgoingMessage> {
    switch (message.topic) {
      case 'add-request':
        return {
          topic: 'add-response',
          payload: this.addAccessory(message.payload),
        };
      case 'remove-request':
        return {
          topic: 'remove-response',
          payload: this.removeAccessory(message.payload),
        };
      case 'get-request':
        return {
          topic: 'get-response',
          payload: this.getAccessories(message.payload),
        };
      case 'set-request':
        return {
          topic: 'set-response',
          payload: this.setValue(message.payload),
        };
      case 'camera-support-request':
        return {
          topic: 'camera-support-response',
          payload: await this.cameraSupport(message.payload),
        };
      default:
        this.log.warn("received message with an unknown topic '%s'", message.topic);
        return {
          topic: 'response',
          payload: <C4HCResponsePayload<never>>{
            ack: false,
            message: `invalid message topic '${message.topic}'`,
            response: message.payload,
          },
        };
    }
  }

  onGet(
    accessory: PlatformAccessory<C4HCPlatformAccessoryContext>,
    service: Service,
    characteristic: Characteristic,
  ): CharacteristicValue {
    let cachedValue = this.characteristicValueCache.get(
      cacheKey(accessory, service, characteristic),
    );
    if (cachedValue === null || cachedValue === undefined) {
      cachedValue = new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE,
      );
    }
    if (cachedValue instanceof this.api.hap.HapStatusError) {
      throw cachedValue;
    }
    return cachedValue;
  }

  async onSet(
    accessory: PlatformAccessory<C4HCPlatformAccessoryContext>,
    service: Service,
    characteristic: Characteristic,
    value: CharacteristicValue,
  ) {
    const key = cacheKey(accessory, service, characteristic);
    if (
      service instanceof this.Service.Lightbulb &&
      characteristic instanceof this.Characteristic.Brightness &&
      value === 100
    ) {
      // Give HomeKit time to send any associated "On" commands
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (this.ignoreNextFullBrightness.delete(key)) {
        return;
      }
    }
    // If this is a light with a brightness and is turning on, use the default brightness
    if (
      service instanceof this.Service.Lightbulb &&
      characteristic instanceof this.Characteristic.On &&
      !this.characteristicValueCache.get(key) &&
      value &&
      service.testCharacteristic(this.Characteristic.Brightness) &&
      accessory.context.definition?.options?.defaultOnBrightness
    ) {
      const brightness = service.getCharacteristic(this.Characteristic.Brightness);
      this.ignoreNextFullBrightness.set(cacheKey(accessory, service, brightness), true);
      brightness.setValue(accessory.context.definition.options.defaultOnBrightness);
    }
    this.characteristicValueCache.set(key, value);
    this.send({
      topic: 'set-request',
      payload: {
        uuid: accessory.UUID,
        name: accessory.displayName,
        service: service.constructor.name,
        characteristic: characteristic.constructor.name,
        identifier:
          service.characteristics.find((c) => c instanceof this.Characteristic.Identifier)?.value ??
          undefined,
        serviceLabelIndex:
          service.characteristics.find((c) => c instanceof this.Characteristic.ServiceLabelIndex)
            ?.value ?? undefined,
        value,
      },
    });
  }

  addAccessory(payload: C4HCAddRequestPayload): C4HCResponsePayload<C4HCAddRequestPayload> {
    let ack = false,
      message;
    const name = payload.name;
    const uuid = payload.uuid;
    const serviceNames = Object.keys(payload?.services ?? {});
    const unknownServiceNames = serviceNames.filter((s) => !this.Service[s]);
    if (serviceNames.length === 0 && !payload.options?.camera) {
      message = 'accessories must contain at least 1 service';
    } else if (unknownServiceNames.length > 0) {
      message = 'unknown service(s): ' + unknownServiceNames.join(', ');
    } else {
      const existingAccessory = this.accessories.has(uuid);
      const accessory = this.accessories.get(uuid) ?? new this.api.platformAccessory(name, uuid);
      if (typeof payload.category === 'number') {
        accessory.category = payload.category;
      }

      // Update the accessory context with the definition.
      accessory.context = <C4HCPlatformAccessoryContext>{
        definition: payload,
      };

      const { error, addedServices = [] } = this.addServicesToAccessory(
        accessory,
        payload.services,
      );

      if (error) {
        message = error;
        this.accessories.delete(accessory.UUID);
        if (!payload.external && existingAccessory) {
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      } else {
        let delegate = this.cameraStreamingDelegates.get(accessory.UUID);
        if (delegate) {
          accessory.removeController(delegate.controller);
          this.cameraStreamingDelegates.delete(accessory.UUID);
        }
        if (accessory.context.definition.options?.camera) {
          delegate = new StreamingDelegate(this.log, this.api, this, accessory);
          accessory.configureController(delegate.controller);
          this.cameraStreamingDelegates.set(accessory.UUID, delegate);
        }
        // Remove any cached services that were orphaned.
        accessory.services
          .filter(
            (service) =>
              !['AccessoryInformation', 'ProtocolInformation', 'HOOBS'].includes(
                service.constructor.name,
              ) &&
              (!this.cameraStreamingDelegates.has(accessory.UUID) ||
                !CAMERA_SERVICE_NAMES.includes(service.constructor.name)) &&
              !addedServices.some((s) => Object.is(s, service)),
          )
          .forEach((service) => {
            this.log.info(
              'Removing orphaned service %s from %s',
              service.constructor.name,
              accessory.displayName || accessory.constructor.name,
            );
            accessory.removeService(service);
          });
        // Valid definition -> register or update the accessory
        ack = true;
        this.accessories.set(accessory.UUID, accessory);
        if (existingAccessory) {
          message = `updated ${payload.external ? 'external ' : ''}accessory '${name}'`;
          if (!payload.external) {
            this.api.updatePlatformAccessories([accessory]);
          } else {
            // TODO: Is there a way to update external accessories?
          }
        } else {
          message = `added ${payload.external ? 'external ' : ''}accessory '${name}'`;
          this.log.info(
            `${payload.external ? 'Exposing external' : 'Adding new'} accessory:`,
            name,
          );
          if (!payload.external) {
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          } else {
            this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
          }
        }
      }
    }
    return {
      ack,
      message,
      response: payload,
    };
  }

  addServicesToAccessory(
    accessory: PlatformAccessory<C4HCPlatformAccessoryContext>,
    servicesDefinition: C4HCServicesDefinition,
    parentService?: Service,
    addedServices?: Service[],
  ): { error?: string; addedServices?: Service[] } {
    addedServices = addedServices ?? [];
    for (const [serviceName, serviceDefinitionOrDefinitions] of Object.entries(
      servicesDefinition,
    )) {
      const serviceDefinitions = !Array.isArray(serviceDefinitionOrDefinitions)
        ? [serviceDefinitionOrDefinitions]
        : serviceDefinitionOrDefinitions;
      const multipleServiceDefinitions = serviceDefinitions.length > 1;
      for (const serviceDefinition of serviceDefinitions) {
        const {
          characteristics: characteristicsDefinition,
          linkedServices = null,
          primary = null,
        } = serviceDefinition === 'default'
          ? { characteristics: <C4HCCharacteristicsDefinition>{} }
          : serviceDefinition;

        const idCharacteristic =
          (<C4HCCharacteristicDefinition>characteristicsDefinition.Identifier)?.value ??
          (<C4HCCharacteristicDefinition>characteristicsDefinition.ServiceLabelIndex)?.value ??
          <'default' | CharacteristicValue>characteristicsDefinition.Identifier ??
          <'default' | CharacteristicValue>characteristicsDefinition.ServiceLabelIndex;
        const identifier = typeof idCharacteristic !== 'number' ? null : idCharacteristic;
        if (parentService && identifier === null) {
          return {
            error: 'linked services must contain an Identifier or ServiceLabelIndex characteristic',
          };
        }
        if (multipleServiceDefinitions && identifier === null) {
          return {
            error:
              'when specifying multiple services, each must contain an Identifier or ServiceLabelIndex characteristic',
          };
        }

        const nameCharacteristic =
          (<C4HCCharacteristicDefinition>characteristicsDefinition.Name)?.value ??
          <'default' | CharacteristicValue>characteristicsDefinition.Name ??
          (<C4HCCharacteristicDefinition>characteristicsDefinition.ConfiguredName)?.value ??
          <'default' | CharacteristicValue>characteristicsDefinition.ConfiguredName;
        const displayName =
          typeof nameCharacteristic !== 'string' || nameCharacteristic === 'default'
            ? null
            : nameCharacteristic;
        if (parentService && displayName === null) {
          return {
            error: 'linked services must contain a Name or ConfiguredName characteristic',
          };
        }

        const service =
          serviceName === 'AccessoryInformation'
            ? accessory.getService(this.Service.AccessoryInformation)
            : accessory.getServiceById(
                this.Service[serviceName],
                `uuid=${accessory.UUID}|service=${serviceName}|id=${identifier ?? 'default'}`,
              ) ||
              accessory.addService(
                this.Service[serviceName],
                displayName ?? accessory.displayName,
                `uuid=${accessory.UUID}|service=${serviceName}|id=${identifier ?? 'default'}`,
              );
        if (!service) {
          return {
            error: `unable to add service ${serviceName} to '${accessory.displayName}'`,
          };
        }
        if (primary !== null) {
          service.setPrimaryService(primary);
        }

        // Add any missing required characteristics
        for (const requiredCharacteristic of service.characteristics) {
          const characteristicName = requiredCharacteristic.constructor.name;
          if (
            characteristicName === 'Name' ||
            characteristicsDefinition[characteristicName] !== undefined
          ) {
            continue;
          }
          characteristicsDefinition[characteristicName] = 'default';
        }
        const { error, addedCharacteristics = [] } = this.addCharacteristicsToService(
          accessory,
          service,
          characteristicsDefinition,
        );
        if (error) {
          return { error };
        }
        // Remove any cached characteristics that were orphaned.
        service.characteristics
          .filter(
            (characteristic) =>
              characteristic.constructor.name !== 'Name' &&
              (!this.adaptiveLightingControllers.has(service.getServiceId()) ||
                !ADAPTIVE_LIGHTING_CHARACTERISTIC_NAMES.includes(
                  characteristic.constructor.name,
                )) &&
              !addedCharacteristics.some((c) => Object.is(c, characteristic)),
          )
          .forEach((characteristic) => {
            this.log.info(
              'Removing orphaned characteristic %s from %s',
              characteristic.constructor.name,
              accessory.displayName || accessory.constructor.name,
            );
            service.removeCharacteristic(characteristic);
          });

        if (linkedServices !== null && !Array.isArray(linkedServices)) {
          return {
            error: `invalid type for service ${serviceName} linkedServices; expected an array`,
          };
        }
        for (const linkedServicesDefinition of linkedServices ?? []) {
          const { error } = this.addServicesToAccessory(
            accessory,
            linkedServicesDefinition,
            service,
            addedServices,
          );
          if (error) {
            return { error };
          }
        }
        addedServices.push(service);
        if (parentService) {
          parentService.addLinkedService(service);
        }
      }
    }
    return { addedServices };
  }

  addCharacteristicsToService(
    accessory: PlatformAccessory<C4HCPlatformAccessoryContext>,
    service: Service,
    characteristics: C4HCCharacteristicsDefinition,
    addedCharacteristics?: Characteristic[],
  ): {
    error?: string;
    addedCharacteristics?: Characteristic[];
  } {
    addedCharacteristics = addedCharacteristics ?? [];
    const serviceName = service.constructor.name;
    for (const [characteristicName, characteristicPropertiesDefinition] of Object.entries(
      characteristics,
    )) {
      if (!(characteristicName in this.Characteristic)) {
        return {
          error: `unknown characteristic ${characteristicName}`,
        };
      }
      const characteristic = service.getCharacteristic(this.Characteristic[characteristicName]);
      if (!characteristic) {
        return {
          error: `unable to add characteristic ${characteristicName} to service ${serviceName}`,
        };
      }
      addedCharacteristics.push(characteristic);
      const characteristicDefinition =
        characteristicPropertiesDefinition === 'default'
          ? <C4HCCharacteristicDefinition>{}
          : characteristicPropertiesDefinition;

      const { value = null, props = null } =
        typeof characteristicDefinition === 'object' &&
        !Array.isArray(characteristicDefinition) &&
        (characteristicDefinition?.props !== undefined ||
          characteristicDefinition?.value !== undefined)
          ? characteristicDefinition
          : { value: characteristicDefinition };

      if (
        props !== null &&
        props !== undefined &&
        typeof props === 'object' &&
        !Array.isArray(props) &&
        Object.keys(props).length > 0
      ) {
        characteristic.setProps(props);
      }

      // Add set/get handlers
      if (
        serviceName !== 'AccessoryInformation' &&
        characteristicName !== 'Name' &&
        !ADAPTIVE_LIGHTING_CHARACTERISTIC_NAMES.includes(characteristicName) &&
        characteristic.props.perms.includes(this.api.hap.Perms.PAIRED_READ)
      ) {
        characteristic.onGet(() => this.onGet(accessory, service, characteristic));
      }
      if (
        serviceName !== 'AccessoryInformation' &&
        characteristicName !== 'Name' &&
        !ADAPTIVE_LIGHTING_CHARACTERISTIC_NAMES.includes(characteristicName) &&
        characteristic.props.perms.includes(this.api.hap.Perms.PAIRED_WRITE)
      ) {
        characteristic.onSet((value) => this.onSet(accessory, service, characteristic, value));
      }
      if (
        value !== null &&
        value !== undefined &&
        value !== 'default' &&
        (Array.isArray(value) || typeof value !== 'object')
      ) {
        let hapStatusError: HapStatusError | null = null;
        if (isHAPStatus(value)) {
          hapStatusError = new this.api.hap.HapStatusError(value);
        }
        this.characteristicValueCache.set(
          cacheKey(accessory, service, characteristic),
          hapStatusError || <CharacteristicValue>value,
        );
        characteristic.updateValue(hapStatusError || value);
      }
    }
    // Check if we can configure adaptive lighting
    if (
      this.api.hap.AdaptiveLightingController &&
      serviceName === 'Lightbulb' &&
      service.testCharacteristic(this.Characteristic.Brightness) &&
      service.testCharacteristic(this.Characteristic.ColorTemperature)
    ) {
      const controller =
        this.adaptiveLightingControllers.get(service.getServiceId()) ||
        new this.api.hap.AdaptiveLightingController(service, {
          controllerMode: this.api.hap.AdaptiveLightingControllerMode.AUTOMATIC,
        });
      this.adaptiveLightingControllers.set(service.getServiceId(), controller);
      try {
        accessory.configureController(controller);
      } catch {
        // Already configured
      }
    } else if (serviceName === 'Lightbulb') {
      const controller = this.adaptiveLightingControllers.get(service.getServiceId());
      if (controller) {
        controller.disableAdaptiveLighting();
        accessory.removeController(controller);
        this.adaptiveLightingControllers.delete(service.getServiceId());
      }
    }
    return { addedCharacteristics };
  }

  removeAccessory(
    payload: C4HCRemoveRequestPayload,
  ): C4HCResponsePayload<C4HCAccessoryDefinition | null> {
    const uuid = payload.uuid;
    const accessory = this.accessories.get(uuid);
    if (accessory) {
      this.log.info('Removing accessory:', accessory.displayName);
      if (!accessory.context?.definition?.external) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      this.accessories.delete(uuid);
      return {
        ack: true,
        message: `removed accessory '${accessory.displayName}'`,
        response: accessory.context.definition,
      };
    }
    return {
      ack: false,
      message: `accessory with UUID '${uuid}' not found`,
      response: null,
    };
  }

  getAccessories(
    payload: C4HCGetRequestPayload,
  ): C4HCResponsePayload<{ [key: string]: C4HCAccessoryDefinition | string }> {
    const accessories = {};
    for (const accessory of this.accessories.values()) {
      if (payload.uuid === 'all' || payload.uuid === accessory.UUID) {
        if (payload.simple) {
          accessories[accessory.UUID] = accessory.context.definition.name;
        } else {
          accessories[accessory.UUID] = accessory.context.definition;
        }
      }
    }
    return {
      ack: true,
      message: `fetched ${Object.keys(accessories).length} accessories`,
      response: accessories,
    };
  }

  setValue(payload: C4HCSetRequestPayload): C4HCResponsePayload<C4HCSetRequestPayload> {
    const uuid = payload?.uuid;
    const accessory = uuid && this.accessories.get(uuid);
    if (!accessory) {
      return {
        ack: false,
        message: `unknown accessory with uuid '${uuid}'`,
        response: payload,
      };
    }
    const serviceType = this.Service[payload.service];
    if (serviceType === undefined) {
      return {
        ack: false,
        message: `unknown service '${payload.service}'`,
        response: payload,
      };
    }
    const characteristicType = this.Characteristic[payload.characteristic];
    if (characteristicType === undefined) {
      return {
        ack: false,
        message: `unknown characteristic '${payload.characteristic}'`,
        response: payload,
      };
    }

    const identifier =
      typeof payload.identifier === 'number'
        ? `${payload.identifier}`
        : typeof payload.serviceLabelIndex === 'number'
          ? `${payload.serviceLabelIndex}`
          : null;
    const service = accessory.getServiceById(
      serviceType,
      `uuid=${accessory.UUID}|service=${payload.service}|id=${identifier ?? 'default'}`,
    );
    if (service === undefined) {
      return {
        ack: false,
        message: `accessory does not have service '${payload.service}'`,
        response: payload,
      };
    }

    const characteristic = service.getCharacteristic(characteristicType);
    if (characteristic === undefined) {
      return {
        ack: false,
        message: `accessory service ${payload.service} does not have characteristic '${payload.characteristic}'`,
        response: payload,
      };
    }

    const value: CharacteristicValue = payload.value;
    if (value === null || value === undefined) {
      return {
        ack: false,
        message: 'value cannot be null or undefined',
        response: payload,
      };
    }

    let hapStatusError: HapStatusError | null = null;
    if (isHAPStatus(value)) {
      hapStatusError = new this.api.hap.HapStatusError(value);
    }

    if (
      payload.service === 'Lightbulb' &&
      payload.characteristic === 'CharacteristicValueTransitionControl'
    ) {
      if (
        !value &&
        this.adaptiveLightingControllers.get(service.getServiceId())?.isAdaptiveLightingActive()
      ) {
        this.log.info(`External control of ${accessory.displayName}; disabling adaptive lighting`);
        this.adaptiveLightingControllers.get(service.getServiceId())?.disableAdaptiveLighting();
      }
    } else {
      this.characteristicValueCache.set(
        cacheKey(accessory, service, characteristic),
        hapStatusError || value,
      );
      characteristic.updateValue(hapStatusError || value);
    }

    return {
      ack: true,
      message: `set '${accessory.displayName}' ${payload.service}.${payload.characteristic} -> ${
        hapStatusError ? getHAPStatusName(hapStatusError.hapStatus) : value
      }`,
      response: payload,
    };
  }

  async cameraSupport(
    payload: C4HCCameraSupportRequest,
  ): Promise<C4HCResponsePayload<C4HCCameraSupportResponse>> {
    try {
      return {
        ack: true,
        message: 'camera support',
        response: {
          codecs: await this.ffmpegCodecs.getCodecs(
            payload === 'default' ? 'all' : (payload?.codecs ?? []),
          ),
        },
      };
    } catch (e: unknown) {
      const error = e as unknown as Error;
      return {
        ack: true,
        message: `failed to probe for camera support: ${error.message}`,
        response: {
          codecs: {},
        },
      };
    }
  }

  send(message: C4HCOutgoingMessage) {
    if (this.wsConnection && this.wsConnection.OPEN) {
      const data = JSON.stringify(message);
      this.log.debug('send: %s', data);
      this.wsConnection.send(data, (error) => {
        if (error) {
          this.log.error('send error; %s', error);
        }
      });
    }
  }
}

function cacheKey(
  accessory: PlatformAccessory<C4HCPlatformAccessoryContext>,
  service: Service,
  characteristic: Characteristic,
): string {
  return `${accessory.UUID}:${service.UUID}|${service.subtype ?? ''}:${characteristic.UUID}`;
}

function isHAPStatus(status: CharacteristicValue): status is HAPStatus {
  return (
    typeof status === 'number' &&
    (status === HAPStatus.INSUFFICIENT_PRIVILEGES ||
      status === HAPStatus.SERVICE_COMMUNICATION_FAILURE ||
      status === HAPStatus.RESOURCE_BUSY ||
      status === HAPStatus.READ_ONLY_CHARACTERISTIC ||
      status === HAPStatus.WRITE_ONLY_CHARACTERISTIC ||
      status === HAPStatus.NOTIFICATION_NOT_SUPPORTED ||
      status === HAPStatus.OUT_OF_RESOURCE ||
      status === HAPStatus.OPERATION_TIMED_OUT ||
      status === HAPStatus.RESOURCE_DOES_NOT_EXIST ||
      status === HAPStatus.INVALID_VALUE_IN_REQUEST ||
      status === HAPStatus.INSUFFICIENT_AUTHORIZATION ||
      status === HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE)
  );
}

function getHAPStatusName(status: HAPStatus): string | null {
  switch (status) {
    case HAPStatus.INSUFFICIENT_PRIVILEGES:
      return 'INSUFFICIENT_PRIVILEGES';
    case HAPStatus.SERVICE_COMMUNICATION_FAILURE:
      return 'SERVICE_COMMUNICATION_FAILURE';
    case HAPStatus.RESOURCE_BUSY:
      return 'RESOURCE_BUSY';
    case HAPStatus.READ_ONLY_CHARACTERISTIC:
      return 'READ_ONLY_CHARACTERISTIC';
    case HAPStatus.WRITE_ONLY_CHARACTERISTIC:
      return 'WRITE_ONLY_CHARACTERISTIC';
    case HAPStatus.NOTIFICATION_NOT_SUPPORTED:
      return 'NOTIFICATION_NOT_SUPPORTED';
    case HAPStatus.OUT_OF_RESOURCE:
      return 'OUT_OF_RESOURCE';
    case HAPStatus.OPERATION_TIMED_OUT:
      return 'OPERATION_TIMED_OUT';
    case HAPStatus.RESOURCE_DOES_NOT_EXIST:
      return 'RESOURCE_DOES_NOT_EXIST';
    case HAPStatus.INVALID_VALUE_IN_REQUEST:
      return 'INVALID_VALUE_IN_REQUEST';
    case HAPStatus.INSUFFICIENT_AUTHORIZATION:
      return 'INSUFFICIENT_AUTHORIZATION';
    case HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE:
      return 'NOT_ALLOWED_IN_CURRENT_STATE';
    default:
      return null;
  }
}
