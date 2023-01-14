import {
  API,
  APIEvent,
  Characteristic,
  CharacteristicValue,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer, Server } from 'http';
import { CharacteristicProps } from 'hap-nodejs/dist/lib/Characteristic';

type Control4ProxyHomebridgePlatformConfig = PlatformConfig & { port: number };

type Control4ProxyIncomingMessage =
  | {
      topic: 'set-request';
      payload: Control4ProxyIncomingSetMessagePayload;
    }
  | {
      topic: 'get-request';
      payload: Control4ProxyIncomingGetMessagePayload;
    }
  | {
      topic: 'add-request';
      payload: Control4ProxyIncomingAddMessagePayload;
    }
  | {
      topic: 'remove-request';
      payload: Control4ProxyIncomingRemoveMessagePayload;
    };

interface Control4ProxyIncomingCommonMessagePayload {
  uuid: string;
}

type Control4ProxyIncomingSetMessagePayload = Control4ProxyIncomingCommonMessagePayload & {
  name: string;
  service: string;
  characteristic: string;
  value: CharacteristicValue;
};

type Control4ProxyIncomingGetMessagePayload = Control4ProxyIncomingCommonMessagePayload & {
  name: string;
  service: string;
  characteristic: string;
};

/**
 * Accessory definitions
 */
interface Control4ProxyAccessoryDefinition {
  uuid: string;
  name: string;
  category?: number;
  services: {
    [key: string]: 'default' | Control4ProxyServiceDefinition;
  };
}

interface Control4ProxyServiceDefinition {
  [key: string]: 'default' | CharacteristicValue | Control4ProxyCharacteristicDefinition;
}

interface Control4ProxyCharacteristicDefinition {
  value?: CharacteristicValue;
  props?: CharacteristicProps;
}

interface Control4ProxyPlatformAccessoryContext {
  definition: Control4ProxyAccessoryDefinition;
}

type Control4ProxyIncomingAddMessagePayload = Control4ProxyIncomingCommonMessagePayload &
  Control4ProxyAccessoryDefinition;

type Control4ProxyIncomingRemoveMessagePayload = Control4ProxyIncomingCommonMessagePayload;

interface Control4ProxyOutgoingMessagePayload<T> {
  ack: boolean;
  message: string;
  response: T;
}

type Control4ProxyOutgoingMessage =
  | {
      topic: 'response';
      payload: Control4ProxyOutgoingMessagePayload<never>;
    }
  | {
      topic: 'add-response';
      payload: Control4ProxyOutgoingMessagePayload<Control4ProxyAccessoryDefinition>;
    }
  | {
      topic: 'remove-response';
      payload: Control4ProxyOutgoingMessagePayload<Control4ProxyAccessoryDefinition | null>;
    }
  | {
      topic: 'get-response';
      payload: Control4ProxyOutgoingMessagePayload<{
        [key: string]: Control4ProxyAccessoryDefinition;
      }>;
    }
  | {
      topic: 'set-response';
      payload: Control4ProxyOutgoingMessagePayload<Control4ProxyIncomingSetMessagePayload>;
    }
  | {
      topic: 'get-request';
      payload: {
        uuid: string;
        name?: string;
        service: string;
        characteristic: string;
      };
    }
  | {
      topic: 'set-request';
      payload: {
        uuid: string;
        name?: string;
        service: string;
        characteristic: string;
        value: CharacteristicValue;
      };
    };

export class Control4ProxyHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly characteristicValueCache: Map<string, CharacteristicValue> = new Map();
  public readonly config: Control4ProxyHomebridgePlatformConfig;
  public readonly server: Server;
  public readonly ws: WebSocketServer;
  private wsConnection: WebSocket | null = null;

  constructor(
    public readonly log: Logger,
    public readonly platformConfig: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.config = <Control4ProxyHomebridgePlatformConfig>this.platformConfig;
    this.server = createServer();
    this.ws = new WebSocketServer({ server: this.server });
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, async () => this.startup());
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
    this.addAccessory(accessory.context.definition);
  }

  async startup() {
    this.ws.on('connection', (ws, req) => {
      this.wsConnection = ws;
      this.wsConnection.on('message', (data) => {
        if (!data) {
          return;
        }
        this.log.debug('receive: %s', data);
        const message = JSON.parse(data.toString());
        if (!message.topic || !message.payload) {
          return;
        }
        this.send(this.onMessage(<Control4ProxyIncomingMessage>message));
      });
      this.wsConnection.on('close', () => {
        this.log.info('client ip %s disconnected', req.socket.remoteAddress);
      });
      this.wsConnection.on('error', (e) => {
        this.log.error('error: %s', e.message);
      });
      this.log.info('client ip %s connected', req.socket.remoteAddress);
    });
    this.server.listen(this.config.port);
  }

  onMessage(message: Control4ProxyIncomingMessage): Control4ProxyOutgoingMessage {
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
      default:
        this.log.warn("Invalid message topic '%s'", message['topic']);
        return {
          topic: 'response',
          payload: {
            ack: false,
            message: `invalid message topic '${message['topic']}'`,
            response: message['payload'],
          },
        };
    }
  }

  onGet(accessory: PlatformAccessory, service: Service, characteristic: Characteristic) {
    // Trigger an update for the characteristic
    // this.send({
    //   topic: 'get-request',
    //   payload: {
    //     uuid: accessory.UUID,
    //     name: accessory.displayName,
    //     service: service.constructor.name,
    //     characteristic: characteristic.constructor.name,
    //   },
    // });
    const cachedValue = this.characteristicValueCache.get(
      cacheKey(accessory, service, characteristic),
    );
    if (cachedValue !== null && cachedValue !== undefined) {
      return cachedValue;
    }
    throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
  }

  onSet(
    accessory: PlatformAccessory,
    service: Service,
    characteristic: Characteristic,
    value: CharacteristicValue,
  ) {
    this.characteristicValueCache.set(cacheKey(accessory, service, characteristic), value);
    this.send({
      topic: 'set-request',
      payload: {
        uuid: accessory.UUID,
        name: accessory.displayName,
        service: service.constructor.name,
        characteristic: characteristic.constructor.name,
        value,
      },
    });
  }

  addAccessory(
    payload: Control4ProxyIncomingAddMessagePayload,
  ): Control4ProxyOutgoingMessagePayload<Control4ProxyIncomingAddMessagePayload> {
    let ack, message;
    const name = payload.name;
    const uuid = payload.uuid;
    const serviceNames = Object.keys(payload?.services ?? {});
    const unknownServiceNames = serviceNames.filter((s) => !this.Service[s]);
    if (serviceNames.length === 0) {
      ack = false;
      message = 'accessories must contain at least 1 service';
    } else if (unknownServiceNames.length > 0) {
      ack = false;
      message = 'unknown service(s): ' + unknownServiceNames.join(', ');
    } else {
      const existingAccessory = this.accessories.has(uuid);
      const accessory = this.accessories.get(uuid) ?? new this.api.platformAccessory(name, uuid);
      if (typeof payload.category === 'number') {
        accessory.category = payload.category;
      }

      // Update the accessory context with the definition.
      accessory.context = <Control4ProxyPlatformAccessoryContext>{
        definition: payload,
      };

      ack = true;
      message = 'unknown failure occurred';
      for (const [serviceName, characteristicDefinition] of Object.entries(payload.services)) {
        const service =
          serviceName === 'AccessoryInformation'
            ? accessory.getService(this.Service.AccessoryInformation)
            : accessory.getServiceById(
                this.Service[serviceName],
                `${accessory.UUID}.${serviceName}`,
              ) ||
              accessory.addService(
                this.Service[serviceName],
                accessory.displayName,
                `${accessory.UUID}.${serviceName}`,
              );
        if (!ack) {
          break;
        }
        if (service === undefined) {
          ack = false;
          message = `unable to add service ${serviceName} to '${accessory.displayName}'`;
          break;
        }

        const characteristics =
          characteristicDefinition === 'default' ? {} : characteristicDefinition;

        // Add any missing required characteristics
        for (const requiredCharacteristic of service.characteristics) {
          const characteristicName = requiredCharacteristic.constructor.name;
          if (characteristicName === 'Name' || characteristics[characteristicName] !== undefined) {
            continue;
          }
          characteristics[characteristicName] = 'default';
        }

        for (const [characteristicName, characteristicPropertiesDefinition] of Object.entries(
          characteristics,
        )) {
          const characteristic =
            this.Characteristic[characteristicName] &&
            service.getCharacteristic(this.Characteristic[characteristicName]);
          if (!characteristic) {
            ack = false;
            message = `unable to add characteristic ${characteristicName} to service ${serviceName}`;
            break;
          }

          const characteristicProperties =
            characteristicPropertiesDefinition === 'default'
              ? {}
              : characteristicPropertiesDefinition;

          const characteristicPropertiesKeys = Object.keys(characteristicProperties);
          const { value = null, props = null } =
            typeof characteristicProperties === 'object' &&
            !Array.isArray(characteristicProperties) &&
            characteristicProperties !== null &&
            characteristicPropertiesKeys.length <= 2 &&
            characteristicPropertiesKeys.every((k) => ['value', 'props'].includes(k))
              ? characteristicProperties
              : { value: characteristicProperties };

          // Add set/get handlers
          if (
            serviceName !== 'AccessoryInformation' &&
            characteristicName !== 'Name' &&
            characteristic.props.perms.includes('pr')
          ) {
            characteristic.onGet(() => this.onGet(accessory, service, characteristic));
          }
          if (
            serviceName !== 'AccessoryInformation' &&
            characteristicName !== 'Name' &&
            characteristic.props.perms.includes('pw')
          ) {
            characteristic.onSet((value) => this.onSet(accessory, service, characteristic, value));
          }
          if (value !== null && value !== undefined && value !== 'default') {
            this.characteristicValueCache.set(
              cacheKey(accessory, service, characteristic),
              <CharacteristicValue>value,
            );
            characteristic.updateValue(value);
          }
          if (props !== null && props !== undefined && Object.keys(props).length > 0) {
            characteristic.setProps(props);
          }
        }
      }
      if (!ack) {
        this.accessories.delete(accessory.UUID);
        if (existingAccessory) {
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      } else {
        // Valid definition -> register or update the accessory
        this.accessories.set(accessory.UUID, accessory);
        if (existingAccessory) {
          message = `updated accessory '${name}'`;
          this.api.updatePlatformAccessories([accessory]);
        } else {
          message = `added accessory '${name}'`;
          this.log.info('Adding new accessory:', name);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }
    }
    return {
      ack,
      message,
      response: payload,
    };
  }

  removeAccessory(
    payload: Control4ProxyIncomingRemoveMessagePayload,
  ): Control4ProxyOutgoingMessagePayload<Control4ProxyAccessoryDefinition | null> {
    const uuid = payload.uuid;
    const accessory = this.accessories.get(uuid);
    if (accessory) {
      this.log.debug("removing accessory '%s'", accessory.displayName);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
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
    payload: Control4ProxyIncomingGetMessagePayload,
  ): Control4ProxyOutgoingMessagePayload<{ [key: string]: Control4ProxyAccessoryDefinition }> {
    const accessories = {};
    for (const accessory of this.accessories.values()) {
      if (payload.uuid === 'all' || payload.uuid === accessory.UUID) {
        accessories[accessory.UUID] = accessory.context.definition;
      }
    }
    return {
      ack: true,
      message: `fetched ${Object.keys(accessories).length} accessories`,
      response: accessories,
    };
  }

  setValue(
    payload: Control4ProxyIncomingSetMessagePayload,
  ): Control4ProxyOutgoingMessagePayload<Control4ProxyIncomingSetMessagePayload> {
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

    const service = accessory.getServiceById(serviceType, `${accessory.UUID}.${payload.service}`);
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

    const value = payload.value;
    if (value === null || value === undefined) {
      return {
        ack: false,
        message: 'value cannot be null or undefined',
        response: payload,
      };
    }

    this.characteristicValueCache.set(cacheKey(accessory, service, characteristic), value);
    characteristic.updateValue(value);

    return {
      ack: true,
      message: `set '${accessory.displayName}' ${payload.service}.${payload.characteristic} -> ${value}`,
      response: payload,
    };
  }

  send(message: Control4ProxyOutgoingMessage) {
    if (this.wsConnection && this.wsConnection.OPEN) {
      this.log.debug('send: %s', JSON.stringify(message, null, 2));
      this.wsConnection.send(JSON.stringify(message), (error) => {
        if (error) {
          this.log.error('send error; %s', error);
        }
      });
    }
  }
}

function cacheKey(
  accessory: PlatformAccessory,
  service: Service,
  characteristic: Characteristic,
): string {
  return `${accessory.UUID}:${service.UUID}:${characteristic.UUID}`;
}
