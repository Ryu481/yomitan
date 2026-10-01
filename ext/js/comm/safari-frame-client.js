/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {generateId} from '../core/utilities.js';

export class SafariFrameClient {
    constructor() {
        /** @type {?import('extension').HtmlElementWithContentWindow} */
        this._frame = null;
        /** @type {?string} */
        this._targetOrigin = null;
        /** @type {number} */
        this._frameId = 0;
        /** @type {boolean} */
        this._connected = false;
        /** @type {number} */
        this._nextId = 0;
        /** @type {Map<string, {resolve: (value: unknown) => void, reject: (reason?: unknown) => void, timeout: import('core').Timeout}>} */
        this._pending = new Map();
        /** @type {string} */
        this._clientId = generateId(16);
        /** @type {?((reason: unknown) => void)} */
        this._cancelConnect = null;

        /** @type {(event: MessageEvent<unknown>) => void} */
        this._onMessageBound = this._onMessage.bind(this);
        window.addEventListener('message', this._onMessageBound);
    }

    /** @type {number} */
    get frameId() {
        return this._frameId;
    }

    /** @returns {boolean} */
    isConnected() {
        return this._connected;
    }

    /**
     * @param {import('extension').HtmlElementWithContentWindow} frame
     * @param {string} targetOrigin
     * @param {number} frameId
     * @param {import('frame-client').SetupFrameFunction} setupFrame
     * @param {number} [timeout]
     * @returns {Promise<void>}
     */
    async connect(frame, targetOrigin, frameId, setupFrame, timeout = 10000) {
        const reconnectError = new Error('Safari popup iframe reconnected');
        this._cancelConnect?.(reconnectError);
        this._clearPending(reconnectError);
        this._connected = false;
        this._frame = frame;
        this._targetOrigin = targetOrigin;
        this._frameId = frameId;
        window.addEventListener('message', this._onMessageBound);

        await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
            const cleanup = () => {
                window.removeEventListener('message', onReady);
                clearTimeout(timer);
                this._cancelConnect = null;
            };

            /** @param {unknown} reason */
            const cancel = (reason) => {
                cleanup();
                reject(reason);
            };

            /** @param {MessageEvent<unknown>} event */
            const onReady = (event) => {
                const data = /** @type {{yomitanSafariPopupRpc?: boolean, type?: string}|null|undefined} */ (event.data);
                if (data?.yomitanSafariPopupRpc !== true || data.type !== 'ready') { return; }
                if (event.source !== frame.contentWindow || !this._isExpectedOrigin(event.origin)) { return; }

                cleanup();
                this._connected = true;
                resolve();
            };

            const timer = setTimeout(() => {
                cancel(new Error('Safari popup iframe handshake timed out'));
            }, timeout);
            this._cancelConnect = cancel;

            // Register before navigating: a cached frame can be ready during setup.
            window.addEventListener('message', onReady);
            try {
                setupFrame(frame);
            } catch (e) {
                cancel(e);
            }
        }));
    }

    /**
     * @template [T=unknown]
     * @param {T} message
     * @returns {{yomitanSafariPopupFrameClientMessage: boolean, data: T}}
     */
    createMessage(message) {
        return {
            yomitanSafariPopupFrameClientMessage: true,
            data: message,
        };
    }

    /**
     * @param {string} action
     * @param {unknown} params
     * @returns {Promise<unknown>}
     */
    invoke(action, params) {
        const contentWindow = this._frame?.contentWindow;
        if (!this._connected || typeof contentWindow === 'undefined' || contentWindow === null) {
            return Promise.reject(new Error('Safari popup iframe is not connected'));
        }

        const id = `${this._clientId}:${++this._nextId}`;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                const item = this._pending.get(id);
                if (item === void 0) { return; }
                this._pending.delete(id);
                item.reject(new Error(`Safari popup iframe RPC timed out: ${action}`));
            }, 10000);

            this._pending.set(id, {resolve, reject, timeout});

            try {
                contentWindow.postMessage({
                    yomitanSafariPopupRpc: true,
                    type: 'invoke',
                    clientId: this._clientId,
                    id,
                    apiAction: action,
                    params,
                }, this._targetOrigin ?? '*');
            } catch (e) {
                clearTimeout(timeout);
                this._pending.delete(id);
                reject(e);
            }
        });
    }

    /** @returns {void} */
    disconnect() {
        window.removeEventListener('message', this._onMessageBound);

        const error = new Error('Safari popup iframe disconnected');
        this._cancelConnect?.(error);
        this._clearPending(error);
        this._connected = false;
        this._frame = null;
    }

    /**
     * @param {Error} error
     * @returns {void}
     */
    _clearPending(error) {
        for (const {reject, timeout} of this._pending.values()) {
            clearTimeout(timeout);
            reject(error);
        }
        this._pending.clear();
    }

    /**
     * @param {MessageEvent<unknown>} event
     * @returns {void}
     */
    _onMessage(event) {
        const data = /** @type {{yomitanSafariPopupRpc?: boolean, type?: string, clientId?: string, id?: string, result?: unknown, error?: string}|null|undefined} */ (event.data);

        if (data?.yomitanSafariPopupRpc !== true || data.type !== 'result') { return; }
        if (event.source !== this._frame?.contentWindow || !this._isExpectedOrigin(event.origin)) { return; }
        if (data.clientId !== this._clientId || typeof data.id !== 'string') { return; }

        const item = this._pending.get(data.id);
        if (item === void 0) { return; }

        this._pending.delete(data.id);
        clearTimeout(item.timeout);

        if (data.error) {
            item.reject(new Error(data.error));
        } else {
            item.resolve(data.result);
        }
    }

    /**
     * @param {string} origin
     * @returns {boolean}
     */
    _isExpectedOrigin(origin) {
        return this._normalizeOrigin(origin) === this._normalizeOrigin(this._targetOrigin);
    }

    /**
     * @param {?string} origin
     * @returns {string}
     */
    _normalizeOrigin(origin) {
        try {
            const url = new URL(origin ?? '');
            return (url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin).toLowerCase();
        } catch {
            return String(origin).toLowerCase();
        }
    }
}
