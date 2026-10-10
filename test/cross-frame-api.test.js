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

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {API} from '../ext/js/comm/api.js';
import {CrossFrameAPI, CrossFrameAPIPort} from '../ext/js/comm/cross-frame-api.js';
import {createApiMap} from '../ext/js/core/api-map.js';
import {ExtensionError} from '../ext/js/core/extension-error.js';
import {log} from '../ext/js/core/log.js';
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
     * @param {(...args: TArgs) => void} listener
     * @returns {boolean}
     */
    hasListener(listener) {
        return this.listeners.has(listener);
    }

    /**
     * @returns {boolean}
     */
    hasListeners() {
        return this.listeners.size > 0;
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

/** @type {ReturnType<typeof createPortMock>[]} */
const mockPorts = [];
/** @type {import('vitest').MockInstance<typeof log.warn>} */
let warnSpy;
const pageInfo = {url: 'https://example.com/', documentTitle: 'Example'};

/**
 * @param {Partial<import('cross-frame-api').PortDetails>} [details]
 * @returns {{port: chrome.runtime.Port, postMessage: import('vitest').Mock<(message: import('cross-frame-api').Message) => void>, onMessage: MockExtensionEvent<[import('cross-frame-api').Message, chrome.runtime.Port]>, onDisconnect: MockExtensionEvent<[chrome.runtime.Port]>, receive: (message: import('cross-frame-api').Message) => void}}
 */
function createPortMock(details) {
    /** @type {MockExtensionEvent<[import('cross-frame-api').Message, chrome.runtime.Port]>} */
    const onMessage = new MockExtensionEvent();
    /** @type {MockExtensionEvent<[chrome.runtime.Port]>} */
    const onDisconnect = new MockExtensionEvent();
    const postMessage = vi.fn(/** @param {import('cross-frame-api').Message} _message */ (_message) => {});
    // Runtime port events do not use the declarative rule methods on Chrome's Event type.
    /** @type {chrome.runtime.Port} */
    const port = {
        name: JSON.stringify({
            name: 'cross-frame-communication-port',
            otherTabId: 1,
            otherFrameId: 2,
            receiverTabId: 1,
            receiverFrameId: 1,
            ...details,
        }),
        onMessage: /** @type {chrome.runtime.Port['onMessage']} */ (/** @type {unknown} */ (onMessage)),
        onDisconnect: /** @type {chrome.runtime.Port['onDisconnect']} */ (/** @type {unknown} */ (onDisconnect)),
        postMessage,
        disconnect: vi.fn(() => onDisconnect.dispatch(port)),
    };
    const result = {
        port,
        postMessage,
        onMessage,
        onDisconnect,
        receive: (/** @type {import('cross-frame-api').Message} */ message) => onMessage.dispatch(message, port),
    };
    mockPorts.push(result);
    return result;
}

/**
 * @param {import('cross-frame-api').ApiMapInit} handlers
 * @returns {{commPort: CrossFrameAPIPort} & ReturnType<typeof createPortMock>}
 */
function createPreparedPort(handlers = []) {
    const mock = createPortMock();
    const commPort = new CrossFrameAPIPort(1, 2, mock.port, createApiMap(handlers));
    commPort.prepare();
    return {commPort, ...mock};
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', new EventTarget());
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const {port, onDisconnect} of mockPorts) {
        onDisconnect.dispatch(port);
    }
    mockPorts.length = 0;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('CrossFrameAPIPort', () => {
    test('sends an invocation and resolves the acknowledged result', async () => {
        const {commPort, receive, postMessage} = createPreparedPort();
        const result = commPort.invoke('frontendGetPageInfo', void 0, 100, 200);
        expect(postMessage).toHaveBeenCalledExactlyOnceWith({
            type: 'invoke', id: 0, data: {action: 'frontendGetPageInfo', params: void 0},
        });
        expect(commPort.activeInvocationCount).toBe(1);
        receive({type: 'ack', id: 0});
        receive({type: 'result', id: 0, data: {result: pageInfo}});
        await expect(result).resolves.toStrictEqual(pageInfo);
        expect(commPort.activeInvocationCount).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('preparing twice dispatches each incoming request to its handler once', () => {
        const popup = {id: 'popup', depth: 1, frameId: 2};
        const handler = vi.fn(/** @type {import('cross-frame-api').ApiHandler<'popupFactoryGetOrCreatePopup'>} */ (() => popup));
        const {commPort, receive, postMessage, onMessage, onDisconnect} = createPreparedPort([['popupFactoryGetOrCreatePopup', handler]]);
        commPort.prepare();
        expect(onMessage.listeners.size).toBe(1);
        expect(onDisconnect.listeners.size).toBe(1);
        const params = {id: 'popup', depth: 1, frameId: 2};
        receive({type: 'invoke', id: 5, data: {action: 'popupFactoryGetOrCreatePopup', params}});
        expect(handler).toHaveBeenCalledExactlyOnceWith(params);
        expect(postMessage.mock.calls).toStrictEqual([
            [{type: 'ack', id: 5}],
            [{type: 'result', id: 5, data: {result: popup}}],
        ]);
    });

    test('dispatches duplicate incoming invocations once while pending and after later requests', async () => {
        const popup = {id: 'popup', depth: 1, frameId: 2};
        /** @type {(result: import('cross-frame-api').ApiReturn<'popupFactoryGetOrCreatePopup'>) => void} */
        let resolvePopup = () => {};
        /** @type {Promise<import('cross-frame-api').ApiReturn<'popupFactoryGetOrCreatePopup'>>} */
        const pendingPopup = new Promise((resolve) => { resolvePopup = resolve; });
        const handler = vi.fn(/** @type {import('cross-frame-api').ApiHandler<'popupFactoryGetOrCreatePopup'>} */ (() => pendingPopup));
        const {receive, postMessage} = createPreparedPort([['popupFactoryGetOrCreatePopup', handler]]);
        /** @type {import('cross-frame-api').InvokeMessage} */
        const firstRequest = {type: 'invoke', id: 0, data: {action: 'popupFactoryGetOrCreatePopup', params: {frameId: 2}}};
        receive(firstRequest);
        receive(firstRequest);
        expect(handler).toHaveBeenCalledExactlyOnceWith(firstRequest.data.params);
        expect(postMessage.mock.calls).toStrictEqual([[{type: 'ack', id: 0}]]);
        resolvePopup(popup);
        await vi.advanceTimersByTimeAsync(0);
        receive(firstRequest);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(postMessage).toHaveBeenCalledTimes(2);
        receive({...firstRequest, id: 1});
        await vi.advanceTimersByTimeAsync(0);
        receive(firstRequest);
        receive({...firstRequest, id: 1});
        expect(handler).toHaveBeenCalledTimes(2);
        expect(postMessage.mock.calls).toStrictEqual([
            [{type: 'ack', id: 0}],
            [{type: 'result', id: 0, data: {result: popup}}],
            [{type: 'ack', id: 1}],
            [{type: 'result', id: 1, data: {result: popup}}],
        ]);
    });

    test.each([
        {ids: [1, 0, 1, 0]},
        {ids: [0, 2, 1, 2, 0, 1, 3, 3]},
        {ids: [5, 3, 1, 2, 4, 0, 5, 3, 1, 2, 4, 0]},
    ])('accepts unseen incoming requests out of order and ignores duplicates ($ids)', ({ids}) => {
        const handler = vi.fn(/** @type {import('cross-frame-api').ApiHandler<'popupFactoryGetOrCreatePopup'>} */ (({id}) => ({
            id: id ?? 'popup', depth: 1, frameId: 2,
        })));
        const {receive, postMessage} = createPreparedPort([['popupFactoryGetOrCreatePopup', handler]]);
        for (const id of ids) {
            receive({type: 'invoke', id, data: {action: 'popupFactoryGetOrCreatePopup', params: {id: `popup-${id}`, frameId: 2}}});
        }
        const uniqueIds = [...new Set(ids)];
        expect(handler.mock.calls).toStrictEqual(uniqueIds.map((id) => [{id: `popup-${id}`, frameId: 2}]));
        expect(postMessage.mock.calls).toStrictEqual(uniqueIds.flatMap((id) => [
            [{type: 'ack', id}],
            [{type: 'result', id, data: {result: {id: `popup-${id}`, depth: 1, frameId: 2}}}],
        ]));
    });

    test('ignores repeated acknowledgements while a result is pending', async () => {
        const {commPort, receive} = createPreparedPort();
        const result = commPort.invoke('frontendGetPageInfo', void 0, 100, 200);
        const assertion = expect(result).resolves.toStrictEqual(pageInfo);
        receive({type: 'ack', id: 0});
        receive({type: 'ack', id: 0});
        receive({type: 'result', id: 0, data: {result: pageInfo}});
        await assertion;
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('repeated acknowledgements do not extend the original response deadline', async () => {
        const {commPort, receive} = createPreparedPort();
        const result = commPort.invoke('frontendGetPageInfo', void 0, 100, 200);
        const assertion = expect(result).rejects.toThrow('Response timeout (frontendGetPageInfo)');
        receive({type: 'ack', id: 0});
        vi.advanceTimersByTime(150);
        receive({type: 'ack', id: 0});
        vi.advanceTimersByTime(49);
        const pendingBeforeDeadline = commPort.activeInvocationCount;
        vi.advanceTimersByTime(1);
        await assertion;
        expect(pendingBeforeDeadline).toBe(1);
        expect(commPort.activeInvocationCount).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('ignores duplicate responses after a successful invocation', async () => {
        const {commPort, receive} = createPreparedPort();
        const result = commPort.invoke('frontendGetPageInfo', void 0, 100, 200);
        receive({type: 'ack', id: 0});
        receive({type: 'result', id: 0, data: {result: pageInfo}});
        await expect(result).resolves.toStrictEqual(pageInfo);
        receive({type: 'ack', id: 0});
        receive({type: 'result', id: 0, data: {result: pageInfo}});
        expect(warnSpy).not.toHaveBeenCalled();
        expect(commPort.activeInvocationCount).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    test.each([
        {failure: 'remote error', expectedMessage: 'Remote failure'},
        {failure: 'acknowledgement timeout', expectedMessage: 'Acknowledgement timeout'},
        {failure: 'response timeout', expectedMessage: 'Response timeout'},
    ])(
        'ignores late responses after $failure without disrupting the next invocation',
        async ({failure, expectedMessage}) => {
            const {commPort, receive} = createPreparedPort();
            const result = commPort.invoke('frontendGetPageInfo', void 0, 100, 200);
            const assertion = expect(result).rejects.toThrow(expectedMessage);
            if (failure === 'acknowledgement timeout') {
                vi.advanceTimersByTime(100);
            } else {
                receive({type: 'ack', id: 0});
                if (failure === 'remote error') {
                    receive({type: 'result', id: 0, data: {error: ExtensionError.serialize(new Error('Remote failure'))}});
                } else {
                    vi.advanceTimersByTime(200);
                }
            }
            await assertion;
            expect(vi.getTimerCount()).toBe(0);
            const nextResult = commPort.invoke('frontendGetPageInfo', void 0, 100, 200);
            receive({type: 'ack', id: 0});
            receive({type: 'result', id: 0, data: {result: pageInfo}});
            expect(commPort.activeInvocationCount).toBe(1);
            receive({type: 'ack', id: 1});
            receive({type: 'result', id: 1, data: {result: pageInfo}});
            await expect(nextResult).resolves.toStrictEqual(pageInfo);
            expect(warnSpy).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    test('continues warning for future, invalid, and unissued request ids', async () => {
        const {commPort, receive} = createPreparedPort();
        const result = commPort.invoke('frontendGetPageInfo', void 0, 100, 200);
        receive({type: 'ack', id: 0});
        receive({type: 'result', id: 0, data: {result: pageInfo}});
        await result;
        const unknownIds = [1, 20, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '0'];
        for (const id of unknownIds) {
            const messageId = /** @type {number} */ (/** @type {unknown} */ (id));
            receive({type: 'ack', id: messageId});
            receive({type: 'result', id: messageId, data: {result: pageInfo}});
        }
        expect(warnSpy).toHaveBeenCalledTimes(unknownIds.length * 2);
        expect(commPort.activeInvocationCount).toBe(0);
    });

    test('rejects a result received before its acknowledgement', async () => {
        const {commPort, receive} = createPreparedPort();
        const result = commPort.invoke('frontendGetPageInfo', void 0, 100, 200);
        receive({type: 'result', id: 0, data: {result: pageInfo}});
        await expect(result).rejects.toThrow('Request 0 not acknowledged (frontendGetPageInfo)');
        expect(commPort.activeInvocationCount).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('disconnect rejects outstanding requests and removes runtime listeners', async () => {
        const {commPort, port, onMessage, onDisconnect, receive} = createPreparedPort();
        const results = [
            commPort.invoke('frontendGetPageInfo', void 0, 100, 200),
            commPort.invoke('popupFactoryGetOrCreatePopup', {frameId: 2}, 100, 200),
        ];
        receive({type: 'ack', id: 0});
        onDisconnect.dispatch(port);
        await expect(Promise.all(results)).rejects.toThrow('Disconnected');
        expect(commPort.isConnected).toBe(false);
        expect(commPort.activeInvocationCount).toBe(0);
        expect(onMessage.hasListeners()).toBe(false);
        expect(onDisconnect.hasListeners()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        receive({type: 'ack', id: 0});
        receive({type: 'result', id: 0, data: {result: pageInfo}});
        expect(warnSpy).not.toHaveBeenCalled();
        await expect(commPort.invoke('frontendGetPageInfo', void 0, 100, 200)).rejects.toThrow('Port is disconnected');
    });
});

describe('CrossFrameAPI connection creation', () => {
    test('a broadcast connection is handled only by its intended tab and frame', async () => {
        /** @type {MockExtensionEvent<[chrome.runtime.Port]>} */
        const onConnect = new MockExtensionEvent();
        vi.stubGlobal('chrome', {runtime: {onConnect}});
        const api = new API(new WebExtension());
        const intendedReceiver = new CrossFrameAPI(api, 1, 1);
        const anotherTab = new CrossFrameAPI(api, 2, 1);
        const anotherFrame = new CrossFrameAPI(api, 1, 2);
        const intendedHandler = vi.fn(/** @type {import('cross-frame-api').ApiHandler<'frontendGetPageInfo'>} */ (() => pageInfo));
        const anotherTabHandler = vi.fn(/** @type {import('cross-frame-api').ApiHandler<'frontendGetPageInfo'>} */ (() => pageInfo));
        const anotherFrameHandler = vi.fn(/** @type {import('cross-frame-api').ApiHandler<'frontendGetPageInfo'>} */ (() => pageInfo));
        intendedReceiver.registerHandlers([['frontendGetPageInfo', intendedHandler]]);
        anotherTab.registerHandlers([['frontendGetPageInfo', anotherTabHandler]]);
        anotherFrame.registerHandlers([['frontendGetPageInfo', anotherFrameHandler]]);
        intendedReceiver.prepare();
        anotherTab.prepare();
        anotherFrame.prepare();
        const {port, receive, postMessage, onMessage} = createPortMock();
        onConnect.dispatch(port);
        receive({type: 'invoke', id: 0, data: {action: 'frontendGetPageInfo', params: void 0}});
        expect(intendedHandler).toHaveBeenCalledExactlyOnceWith(void 0);
        expect(anotherTabHandler).not.toHaveBeenCalled();
        expect(anotherFrameHandler).not.toHaveBeenCalled();
        expect(port.disconnect).not.toHaveBeenCalled();
        expect(onMessage.listeners.size).toBe(1);
        expect(postMessage.mock.calls).toStrictEqual([
            [{type: 'ack', id: 0}],
            [{type: 'result', id: 0, data: {result: pageInfo}}],
        ]);
        postMessage.mockClear();
        const openSpy = vi.spyOn(api, 'openCrossFramePort').mockRejectedValue(new Error('Port should be reused'));
        const result = intendedReceiver.invoke(2, 'frontendGetPageInfo', void 0);
        await vi.advanceTimersByTimeAsync(0);
        expect(postMessage).toHaveBeenCalledExactlyOnceWith({
            type: 'invoke', id: 0, data: {action: 'frontendGetPageInfo', params: void 0},
        });
        receive({type: 'ack', id: 0});
        receive({type: 'result', id: 0, data: {result: pageInfo}});
        await expect(result).resolves.toStrictEqual(pageInfo);
        expect(openSpy).not.toHaveBeenCalled();
        expect(port.disconnect).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('simultaneous invocations share one pending connection', async () => {
        /** @type {MockExtensionEvent<[chrome.runtime.Port]>} */
        const onConnect = new MockExtensionEvent();
        vi.stubGlobal('chrome', {runtime: {onConnect}});
        const api = new API(new WebExtension());
        const crossFrameAPI = new CrossFrameAPI(api, 1, 1);
        crossFrameAPI.prepare();
        const {port, receive, postMessage} = createPortMock();
        /** @type {(() => void)[]} */
        const completeConnections = [];
        const openSpy = vi.spyOn(api, 'openCrossFramePort').mockImplementation((targetTabId, targetFrameId) => new Promise((resolve) => {
            completeConnections.push(() => {
                onConnect.dispatch(port);
                resolve({targetTabId, targetFrameId});
            });
        }));
        const results = [
            crossFrameAPI.invoke(2, 'frontendGetPageInfo', void 0),
            crossFrameAPI.invoke(2, 'frontendGetPageInfo', void 0),
        ];
        for (const complete of completeConnections) { complete(); }
        await vi.advanceTimersByTimeAsync(0);
        for (const [message] of postMessage.mock.calls) {
            if (message.type !== 'invoke') { continue; }
            receive({type: 'ack', id: message.id});
            receive({type: 'result', id: message.id, data: {result: pageInfo}});
        }
        await expect(Promise.all(results)).resolves.toStrictEqual([pageInfo, pageInfo]);
        expect(openSpy).toHaveBeenCalledExactlyOnceWith(1, 2);
        expect(postMessage).toHaveBeenCalledTimes(2);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('a failed connection attempt allows a later retry', async () => {
        /** @type {MockExtensionEvent<[chrome.runtime.Port]>} */
        const onConnect = new MockExtensionEvent();
        vi.stubGlobal('chrome', {runtime: {onConnect}});
        const api = new API(new WebExtension());
        const crossFrameAPI = new CrossFrameAPI(api, 1, 1);
        crossFrameAPI.prepare();
        const {port, receive} = createPortMock();
        const openSpy = vi.spyOn(api, 'openCrossFramePort')
            .mockRejectedValueOnce(new Error('Connection failed'))
            .mockImplementationOnce(async (targetTabId, targetFrameId) => {
                onConnect.dispatch(port);
                return {targetTabId, targetFrameId};
            });
        await expect(crossFrameAPI.invoke(2, 'frontendGetPageInfo', void 0)).rejects.toThrow('Connection failed');
        const result = crossFrameAPI.invoke(2, 'frontendGetPageInfo', void 0);
        await vi.advanceTimersByTimeAsync(0);
        receive({type: 'ack', id: 0});
        receive({type: 'result', id: 0, data: {result: pageInfo}});
        await expect(result).resolves.toStrictEqual(pageInfo);
        expect(openSpy).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });
});
