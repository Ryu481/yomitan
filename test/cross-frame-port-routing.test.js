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

/* global chrome */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {API} from '../ext/js/comm/api.js';
import {CrossFrameAPI} from '../ext/js/comm/cross-frame-api.js';
import {WebExtension} from '../ext/js/extension/web-extension.js';

/**
 * @template {unknown[]} TArgs
 */
class MockExtensionEvent {
    constructor() {
        /** @type {Set<(...args: TArgs) => void>} */
        this.listeners = new Set();
    }

    /**
     * @param {(...args: TArgs) => void} listener
     */
    addListener(listener) {
        this.listeners.add(listener);
    }

    /**
     * @param {(...args: TArgs) => void} listener
     */
    removeListener(listener) {
        this.listeners.delete(listener);
    }

    /**
     * @param {TArgs} args
     */
    dispatch(...args) {
        for (const listener of this.listeners) {
            listener(...args);
        }
    }
}

/** @type {chrome.runtime.Port[]} */
const backgroundPorts = [];

/**
 * @param {string} name
 * @param {(message: import('cross-frame-api').Message) => void} onPostMessage
 * @param {() => void} onDisconnectPort
 * @returns {{port: chrome.runtime.Port, onMessage: MockExtensionEvent<[import('cross-frame-api').Message, chrome.runtime.Port]>, onDisconnect: MockExtensionEvent<[chrome.runtime.Port]>}}
 */
function createPort(name, onPostMessage, onDisconnectPort) {
    /** @type {MockExtensionEvent<[import('cross-frame-api').Message, chrome.runtime.Port]>} */
    const onMessage = new MockExtensionEvent();
    /** @type {MockExtensionEvent<[chrome.runtime.Port]>} */
    const onDisconnect = new MockExtensionEvent();
    /** @type {chrome.runtime.Port} */
    const port = {
        name,
        onMessage: /** @type {chrome.runtime.Port['onMessage']} */ (/** @type {unknown} */ (onMessage)),
        onDisconnect: /** @type {chrome.runtime.Port['onDisconnect']} */ (/** @type {unknown} */ (onDisconnect)),
        postMessage: vi.fn(onPostMessage),
        disconnect: vi.fn(onDisconnectPort),
    };
    return {port, onMessage, onDisconnect};
}

afterEach(() => {
    for (const port of backgroundPorts) { port.disconnect(); }
    backgroundPorts.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Backend cross-frame port routing', () => {
    test.each([
        {source: [11, 0], target: [22, 0], unrelated: [[33, 0], [11, 1], [22, 1]]},
        {source: [11, 0], target: [11, 5], unrelated: [[11, 6], [22, 0], [22, 5]]},
    ])('routes a request and reverse response between $source and $target after broadcast connect events', async ({source, target, unrelated}) => {
        vi.stubGlobal('window', new EventTarget());
        vi.stubGlobal('document', new EventTarget());
        /** @type {MockExtensionEvent<[chrome.runtime.Port]>} */
        const onConnect = new MockExtensionEvent();
        /** @type {{background: ReturnType<typeof createPort>, receivers: ReturnType<typeof createPort>[]}[]} */
        const channels = [];
        /** @type {import('vitest').Mock<(tabId: number, connectInfo: {frameId: number, name: string}) => chrome.runtime.Port>} */
        const connect = vi.fn((_tabId, {name}) => {
            /** @type {ReturnType<typeof createPort>[]} */
            const receivers = [];
            let disconnected = false;
            const background = createPort(name, (message) => {
                for (const receiver of receivers) {
                    receiver.onMessage.dispatch(message, receiver.port);
                }
            }, () => {
                if (disconnected) { return; }
                disconnected = true;
                background.onDisconnect.dispatch(background.port);
                for (const receiver of receivers) {
                    receiver.onDisconnect.dispatch(receiver.port);
                }
            });
            backgroundPorts.push(background.port);
            channels.push({background, receivers});
            // Model a runtime delivering the connection to every tab/frame.
            // Each recipient gets its own Port for the same native channel.
            for (const listener of onConnect.listeners) {
                const receiver = createPort(name, (message) => background.onMessage.dispatch(message, background.port), () => background.port.disconnect());
                receivers.push(receiver);
                listener(receiver.port);
            }
            return background.port;
        });
        vi.stubGlobal('chrome', {runtime: {onConnect}, tabs: {connect}});

        // eslint-disable-next-line no-underscore-dangle, @typescript-eslint/unbound-method
        const openCrossFramePort = Backend.prototype._onApiOpenCrossFramePort;
        const backendContext = {_checkLastError: () => {}};
        const endpoints = [source, target, ...unrelated].map(([tabId, frameId]) => {
            const api = new API(new WebExtension());
            const openSpy = vi.spyOn(api, 'openCrossFramePort').mockImplementation((targetTabId, targetFrameId) => Promise.resolve(openCrossFramePort.call(backendContext, {
                targetTabId, targetFrameId,
            }, /** @type {chrome.runtime.MessageSender} */ (/** @type {unknown} */ ({tab: {id: tabId}, frameId})))));
            const crossFrameAPI = new CrossFrameAPI(api, tabId, frameId);
            const pageInfo = {url: `https://example.com/${tabId}/${frameId}`, documentTitle: `${tabId}:${frameId}`};
            const handler = vi.fn(/** @type {import('cross-frame-api').ApiHandler<'frontendGetPageInfo'>} */ (() => pageInfo));
            crossFrameAPI.registerHandlers([['frontendGetPageInfo', handler]]);
            crossFrameAPI.prepare();
            return {crossFrameAPI, pageInfo, handler, openSpy};
        });
        const [sourceEndpoint, targetEndpoint, ...unrelatedEndpoints] = endpoints;

        await expect(sourceEndpoint.crossFrameAPI.invokeTab(target[0], target[1], 'frontendGetPageInfo', void 0)).resolves.toStrictEqual(targetEndpoint.pageInfo);
        await expect(targetEndpoint.crossFrameAPI.invokeTab(source[0], source[1], 'frontendGetPageInfo', void 0)).resolves.toStrictEqual(sourceEndpoint.pageInfo);

        expect(sourceEndpoint.openSpy).toHaveBeenCalledExactlyOnceWith(target[0], target[1]);
        expect(targetEndpoint.openSpy).not.toHaveBeenCalled();
        expect(connect.mock.calls.map(([tabId, {frameId}]) => [tabId, frameId])).toStrictEqual([source, target]);
        expect(sourceEndpoint.handler).toHaveBeenCalledExactlyOnceWith(void 0);
        expect(targetEndpoint.handler).toHaveBeenCalledExactlyOnceWith(void 0);
        for (const endpoint of unrelatedEndpoints) {
            expect(endpoint.handler).not.toHaveBeenCalled();
            expect(endpoint.openSpy).not.toHaveBeenCalled();
        }
        for (const {background, receivers} of channels) {
            expect(background.port.disconnect).not.toHaveBeenCalled();
            expect(receivers.filter(({onMessage}) => onMessage.listeners.size > 0)).toHaveLength(1);
            for (const {port} of receivers) {
                expect(port.disconnect).not.toHaveBeenCalled();
            }
        }
    });
});
