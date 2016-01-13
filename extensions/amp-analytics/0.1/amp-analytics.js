/**
 * Copyright 2015 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {assertHttpsUrl} from '../../../src/url';
import {isExperimentOn} from '../../../src/experiments';
import {installCidService} from '../../../src/service/cid-impl';
import {log} from '../../../src/log';
import {urlReplacementsFor} from '../../../src/url-replacements';
import {expandTemplate} from '../../../src/string';
import {xhrFor} from '../../../src/xhr';

import {addListener} from './instrumentation';
import {sendRequest} from './transport';
import {ANALYTICS_CONFIG} from './vendors';


installCidService(AMP.win);


/** @const */
const EXPERIMENT = 'amp-analytics';

export class AmpAnalytics extends AMP.BaseElement {

  /**
   * @return {boolean}
   * @private
   */
  isExperimentOn_() {
    return isExperimentOn(this.getWin(), EXPERIMENT);
  }

  /** @override */
  isLayoutSupported(unusedLayout) {
    return true;
  }

  /**
   * @override
   */
  createdCallback() {
    if (!this.isExperimentOn_()) {
      return;
    }

    /**
     * @const {!JSONObject} Copied here for tests.
     * @private
     */
    this.predefinedConfig_ = ANALYTICS_CONFIG;
  }

  /** @override */
  layoutCallback() {
    if (!this.isExperimentOn_()) {
      return Promise.resolve();
    }

    this.element.setAttribute('aria-hidden', 'true');

    /**
     * @private {?string} Predefinedtype associated with the tag. If specified,
     * the config from the predefined type is merged with the inline config
     */
    this.type_ = null;

    /**
     * @private {Object<string, string>} A map of request names to the request
     * format string used by the tag to send data
     */
    this.requests_ = {};

    /**
     * @private {JSONObject}
     */
    this.remoteConfig = {};

    /**
     * @private {boolean} Queue iframe requests until the iframe handler is loaded
     */
    this.iframeQueueing_ = true;

    /**
     * @private {Array<JSONObject>} the queued requests
     */
    this.iframeQueue_ = [];

    /**
     * @private {Object<string, iframe>} A map of all iframes that have been
     * loaded for analytics calls
     */
    this.loadedIframes_ = {};

    return this.fetchRemoteConfig_().then(() => {
      /**
       * @private {!JSONObject} The analytics config associated with the tag
       */
      this.config_ = this.mergeConfigs_();

      if (this.hasOptedOut_()) {
        // Nothing to do when the user has opted out.
        log.fine(this.getName_(), 'User has opted out. No hits will be sent.');
        return Promise.resolve();
      }

      this.generateRequests_();

      if (!this.config_['triggers']) {
        log.error(this.getName_(), 'No triggers were found in the config. No ' +
            'analytics data will be sent.');
        return Promise.resolve();
      }

      // Trigger callback can be synchronous. Do the registration at the end.
      for (const k in this.config_['triggers']) {
        if (this.config_['triggers'].hasOwnProperty(k)) {
          const trigger = this.config_['triggers'][k];
          if (!trigger['on'] || !trigger['request']) {
            log.warn(this.getName_(), '"on" and "request" attributes are ' +
                'required for data to be collected.');
            continue;
          }
          addListener(this.getWin(), trigger['on'],
              this.handleEvent_.bind(this, trigger), trigger['selector']);
        }
      }
    });
  }

  /**
   * Returns a promise that resolves when remote config is ready (or
   * immediately if no remote config is specified.)
   * @private
   * @return {!Promise<>}
   */
  fetchRemoteConfig_() {
    const remoteConfigUrl = this.element.getAttribute('config');
    if (!remoteConfigUrl) {
      return Promise.resolve();
    }
    assertHttpsUrl(remoteConfigUrl);
    log.fine(this.getName_(), 'Fetching remote config', remoteConfigUrl);
    return xhrFor(this.getWin()).fetchJson(remoteConfigUrl).then(jsonValue => {
      this.remoteConfig_ = jsonValue;
      log.fine(this.getName_(), 'Remote config loaded', remoteConfigUrl);
    }, err => {
      log.warn(this.getName_(), 'Error loading remote config',
          remoteConfigUrl, err);
    });
  }

  /**
   * Merges various sources of configs and stores them in a member variable.
   *
   * Order of precedence for configs from highest to lowest:
   * - Remote config: specified through an attribute of the tag.
   * - Inline config: specified insize the tag.
   * - Predefined config: Defined as part of the platform.
   * - Default config: Built-in config shared by all amp-analytics tags.
   *
   * @private
   * @return {!JSONObject}
   */
  mergeConfigs_() {
    let inlineConfig = {};
    try {
      const children = this.element.children;
      if (children.length == 1) {
        const child = children[0];
        if (child.tagName.toUpperCase() == 'SCRIPT' &&
            child.getAttribute('type').toUpperCase() == 'APPLICATION/JSON') {
          inlineConfig = JSON.parse(children[0].textContent);
        } else {
          log.warn(this.getName_(), 'The analytics config should be put in a ' +
              '<script> tag with type=application/json');
        }
      } else if (children.length > 1) {
        log.warn(this.getName_(),
            'The tag should contain only one <script> child.');
      }
    }
    catch (er) {
      log.warn(this.getName_(), 'Analytics config could not be parsed. ' +
          'Is it in a valid JSON format?', er);
    }

    const config = {};
    const defaultConfig = this.predefinedConfig_['default'] || {};
    const typeConfig = this.predefinedConfig_[
      this.element.getAttribute('type')] || {};

    config['vars'] = config['vars'] || {};

    this.mergeObjects_(defaultConfig, config);
    this.mergeObjects_(typeConfig, config);
    this.mergeObjects_(inlineConfig, config);
    this.mergeObjects_(this.remoteConfig_, config);
    return config;
  }

  /**
   * @return {boolean} true if the user has opted out.
   */
  hasOptedOut_() {
    if (!this.config_['optout']) {
      return false;
    }

    const props = this.config_['optout'].split('.');
    let k = this.getWin();
    for (let i = 0; i < props.length; i++) {
      if (!k) {
        return false;
      }
      k = k[props[i]];
    }
    return k();
  }

  /**
   * Goes through all the requests in predefined vendor config and tag's config
   * and creates a map of request name to request template. These requests can
   * then be used while sending a request to a server.
   *
   * @private
   */
  generateRequests_() {
    const requests = {};
    if (!this.config_ || !this.config_['requests']) {
      log.error(this.getName_(), 'No request strings defined. Analytics data ' +
          'will not be sent from this page.');
      return;
    }
    for (const k in this.config_['requests']) {
      if (this.config_['requests'].hasOwnProperty(k)) {
        requests[k] = this.config_['requests'][k];
      }
    }
    this.requests_ = requests;

    // Expand any placeholders. For requests, we expand each string up to 5
    // times to support nested requests. Leave any unresolved placeholders.
    for (const k in this.requests_) {
      this.requests_[k] = expandTemplate(this.requests_[k], key => {
        return this.requests_[key] || '${' + key + '}';
      }, 5);
    }
  }

  /**
   * Callback for events that are registered by the config's triggers. This
   * method generates routes validates the request, expands it and forwards
   * the request to the appropriate handler
   *
   * @param {!JSONObject} trigger JSON config block that resulted in this event.
   * @param {!Object} unusedEvent Object with details about the event.
   * @private
   */
  handleEvent_(trigger, unusedEvent) {
    let request = this.requests_[trigger['request']];
    if (!request) {
      log.warn(this.getName_(),
          'Ignoring event. Request string not found', trigger['request']);
      return;
    }

    // Replace placeholders with URI encoded values.
    // Precedence is trigger.vars > config.vars.
    // Nested expansion not supported.
    request = expandTemplate(request, key => {
      const match = key.match(/([^(]*)(\([^)]*\))?/);
      const name = match[1];
      const argList = match[2] || '';
      const val = encodeURIComponent(
          (trigger['vars'] && trigger['vars'][name]) ||
          (this.config_['vars'] && this.config_['vars'][name]) || '');
      return val + argList;
    });

    if (request.startsWith("iframe")) {
      this.handleIframe_(request, trigger, unusedEvent);
    }
    else {
      this.handleGet_(request, trigger, unusedEvent);
    }
  }

  /**
   * Callback for events that are registered by the config's iframe triggers.
   * This method generates the request and sends the request out.
   *
   * @param {!JSONObject} request string which contains the url to be loaded
   *                              into the iframe
   * @param {!JSONObject} trigger JSON config block that resulted in this event.
   * @param {!Object} unusedEvent Object with details about the event.
   * @private
   */
  handleIframe_(request, trigger, unusedEvent) {
    const vars = this.mergeObjects_(this.config_.vars, trigger.vars);
    vars.trigger = trigger;
    vars.event = unusedEvent;

    // While queuing is enabled load all requests into the queue
    if (this.iframeQueueing_) {
      this.iframeQueue_.push(vars);
    }

    // has this iframe been used to analytics requests
    let iframe = this.loadedIframes_[trigger.request];

    if (!iframe) {
      // does the iframe exist on the page somewhere else
      iframe = document.getElementById(trigger.request);
      if (iframe && iframe.nodeName.toLowerCase() != "iframe") {
        this.iframeQueue_.push = [];
        log.warn(this.getName_(), 'An element with id' +trigger.request+' already exists');
        return;
      }
      this.loadedIframes_[trigger.request] = iframe;
    }

    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.onload = () => {
        while (this.iframeQueue_.length > 0) {
          iframe.contentWindow.postMessage(this.iframeQueue_.shift(), "*");
        }
        this.iframeQueueing_ = false;
      };
      iframe.src      = "https" + request.substr("iframe".length);
      iframe.id       = trigger.request;
      iframe.width    = 0;
      iframe.height   = 0;
      iframe.sandbox  = 'allow-scripts allow-same-origin';
      iframe.position = "fixed";
      iframe.display  = "none";

      this.element.appendChild(iframe);
      this.loadedIframes_[trigger.request] = iframe;
    }
    else {
      iframe.contentWindow.postMessage(vars, "*");
    }
  }

  /**
   * Callback for events that are registered by the config's request triggers.
   * This method generates the request and sends the request out.
   *
   * @param {!JSONObject} trigger JSON config block that resulted in this event.
   * @param {!Object} unusedEvent Object with details about the event.
   * @private
   */
  handleGet_(request, trigger, unusedEvent) {
    // For consistentcy with amp-pixel we also expand any url replacements.
    urlReplacementsFor(this.getWin()).expand(request).then(
        request => this.sendRequest_(request));
  }

  /**
   * @param {string} request The full request string to send.
   * @private
   */
  sendRequest_(request) {
    if (!request) {
      log.warn(this.getName_(), 'Request not sent. Contents empty.');
      return;
    }
    sendRequest(this.getWin(), request, this.config_['transport'] || {});
  }

  /**
   * @return {string} Returns a string to identify this tag. May not be unique
   * if the element id is not unique.
   * @private
   */
  getName_() {
    return 'AmpAnalytics ' +
        (this.element.getAttribute('id') || '<unknown id>');
  }

  /**
   * Merges two objects. If the value is array or plain object, the values are
   * merged otherwise the value is overwritten.
   *
   * @param {Object|Array} from Object or array to merge from
   * @param {Object|Array} to Object or Array to merge into
   * @private
   */
  mergeObjects_(from, to) {
    // Checks if the given object is a plain object.
    const isObject = function(someObj) {
      return Object.prototype.toString.call(someObj) === '[object Object]';
    };

    if (to === null || to === undefined) {
      to = {};
    }

    for (const property in from) {
      if (from.hasOwnProperty(property)) {
        // Only deal with own properties.
        if (Array.isArray(from[property])) {
          if (!Array.isArray(to[property])) {
            to[property] = [];
          }
          to[property] = this.mergeObjects_(from[property], to[property]);
        } else if (isObject(from[property])) {
          if (!isObject(to[property])) {
            to[property] = {};
          }
          to[property] = this.mergeObjects_(from[property], to[property]);
        } else {
          to[property] = from[property];
        }
      }
    }
    return to;
  }
}

AMP.registerElement('amp-analytics', AmpAnalytics);
