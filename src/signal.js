/**
 * Hubot-signal is an adapter for the Hubot chatbot framework which allows a
 * Hubot instance to communicate via the Signal messaging system.
 */

"use strict";

const ByteBuffer = require("bytebuffer");
const Api = require("libsignal-service");
const ProtocolStore = require("./protocol_store.js");
const Adapter = require("hubot/es2015").Adapter;
const TextMessage = require("hubot/es2015").TextMessage;
const User = require("hubot/es2015").User;
const Response = require("hubot/es2015").Response;

/**
 * An extension of Hubot's TextMessage to ensure attachments and group ID's
 * are available to other external Hubot scripts that may want to use them.
 * @class
 */
class SignalMessage extends TextMessage {
  constructor(user, body, attachments, timestamp, group) {
    super(user, body, timestamp);
    this.attachments = attachments || [];
    if (group) {
      this.group = group.id;
    }
  }
}

/**
 * An extension of Hubot's Response object which makes available methods for
 * sending attachments to users.
 * @class
 */
class SignalResponse extends Response {
  sendAttachments(attachments, ...strings) {
    this.robot.adapter._send(this.envelope, attachments, ...strings);
  }

  replyAttachments(attachments, ...strings) {
    this.robot.adapter._reply(this.envelope, attachments, ...strings);
  }
}

/**
 * An implementation of the Hubot class Adapter, this is loaded by Hubot at
 * runtime and attempts to connect to the Signal messenger server. It passes
 * the available Hubot Brain object to the Signal library for key storage.
 * @class
 */
class Signal extends Adapter {
  constructor(...args) {
    super(args);
    this.number = process.env.HUBOT_SIGNAL_NUMBER;
    this.password = process.env.HUBOT_SIGNAL_PASSWORD;
    this.store = new ProtocolStore(this.robot);
    this.accountManager = new Api.AccountManager(
      this.number,
      this.password,
      this.store
    );
    this.loaded = false;
  }

  send(envelope, ...strings) {
    this._send(envelope, [], ...strings);
    this.robot.logger.debug("Sent!");
  }

  reply(envelope, ...strings) {
    this._send(envelope, [], ...strings);
    this.robot.logger.debug("Replied!");
  }

  _send(envelope, attachments, ...strings) {
    if (envelope.room == null) {
      this.emit(
        "error",
        new Error(
          "Cannot send a message without a valid room. Envelopes should contain a room property set to a phone number."
        )
      );
      return;
    }
    const text = strings.join();
    const now = Date.now();
    const group = this.store.groupsGetGroup(envelope.room);
    if (group === null || group === undefined) {
      this.robot.logger.debug("Sending direct message to " + envelope.room);
      this.messageSender
        .sendMessageToNumber(
          envelope.room,
          text,
          attachments || [],
          now,
          undefined,
          this.store.get("profileKey")
        )
        .then(result => {
          this.robot.logger.debug(result);
        })
        .catch(err => {
          this.emit("error", err);
        });
    } else {
      this.robot.logger.debug("Sending message to group " + envelope.room);
      this.messageSender
        .sendMessageToGroup(
          envelope.room,
          text,
          attachments || [],
          now,
          undefined,
          this.store.get("profileKey")
        )
        .then(result => {
          this.robot.logger.debug(result);
        })
        .catch(err => {
          this.emit("error", err);
        });
    }
  }

  _request() {
    this.robot.logger.info("Requesting code.");
    return this.accountManager.requestSMSVerification(this.number);
  }

  _register() {
    this.robot.logger.info("Registering account.");
    return this.accountManager.registerSingleDevice(
      this.number,
      process.env.HUBOT_SIGNAL_CODE
    );
  }

  _receive(source, body, attachments, timestamp, group) {
    if (!group) {
      // Prepend robot name to direct messages that don't include it.
      const startOfText = body.indexOf("@") === 0 ? 1 : 0;
      const robotIsNamed =
        body.indexOf(this.robot.name) === startOfText ||
        body.indexOf(this.robot.alias) === startOfText;
      if (!robotIsNamed) {
        body = `${this.robot.name} ${body}`;
      }
    }
    const user = this.robot.brain.userForId(source);
    this.robot.receive(
      new SignalMessage(user, body, attachments, timestamp, group)
    );
  }

  _connect() {
    this.robot.logger.debug("Connecting to service.");
    const signalingKey = this.store.get("signaling_key");
    if (!signalingKey) {
      this.emit(
        "error",
        new Error(
          "No signaling key is defined, perhaps we didn't successfully register?"
        )
      );
      process.exit(1);
    }

    // Override the default response object.
    this.robot.Response = SignalResponse;

    this.messageSender = new Api.MessageSender(
      this.number,
      this.password,
      this.store
    );
    const signalingKeyBytes = ByteBuffer.wrap(
      signalingKey,
      "binary"
    ).toArrayBuffer();
    this.messageReceiver = new Api.MessageReceiver(
      this.number.concat(".1"),
      this.password,
      signalingKeyBytes,
      this.store
    );
    this.messageReceiver.addEventListener("message", ev => {
      const source = ev.data.source.toString();
      this._receive(
        source,
        ev.data.message.body.toString(),
        ev.data.message.attachments,
        ev.data.timestamp.toString(),
        ev.data.message.group
      );
    });
  }

  _run() {
    this.loaded = true;
    this.robot.logger.debug("Received 'loaded' event, running adapter.");
    if (!this.store.get("profileKey")) {
      if (!process.env.HUBOT_SIGNAL_CODE) {
        Promise.resolve(this._request())
          .then(result => {
            this.robot.logger.info(
              `Sending verification code to ${
                this.number
              }. Once you receive the code, start the bot again while supplying the code via the environment variable HUBOT_SIGNAL_CODE.`
            );
            process.exit(0);
          })
          .catch(err => {
            this.emit("error", err);
            process.exit(1);
          });
      } else {
        Promise.resolve(this._register())
          .then(result => {
            this.robot.logger.info(result);
            this._connect();
          })
          .catch(err => {
            this.emit("error", err);
            process.exit(1);
          });
      }
    } else {
      this._connect();
    }
  }

  run() {
    this.robot.logger.debug("Loading signal-service adapter.");
    // We need to wait until the brain is loaded so we can grab keys.
    this.robot.brain.on("loaded", () => {
      this.loaded || this._run();
    });
    // Lies!
    this.emit("connected");
  }
}

exports.use = robot => new Signal(robot);
