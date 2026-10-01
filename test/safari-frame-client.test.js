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

import {JSDOM} from 'jsdom';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {SafariFrameClient} from '../ext/js/comm/safari-frame-client.js';

const targetOrigin = 'safari-web-extension://B62C7AA7-C130-4CF6-974C-A6A307E119ED';
/** @type {import('jsdom').DOMWindow} */
let window;
/** @type {HTMLIFrameElement} */
let frame;
/** @type {import('vitest').Mock<(message: unknown, targetOrigin?: string|WindowPostMessageOptions) => void>} */
let postMessage = vi.fn();

/**
 * @param {unknown} data
 * @param {MessageEventSource|null} [source]
 * @param {string} [origin]
 * @returns {void}
 */
function sendMessage(data, source = frame.contentWindow, origin = targetOrigin) {
    window.dispatchEvent(new window.MessageEvent('message', {data, source, origin}));
}

/** @returns {void} */
function sendReady() {
    sendMessage({yomitanSafariPopupRpc: true, type: 'ready'});
}

/**
 * @param {unknown} result
 * @returns {void}
 */
function sendResult(result) {
    const {clientId, id} = /** @type {{clientId: string, id: string}} */ (postMessage.mock.calls[postMessage.mock.calls.length - 1][0]);
    sendMessage({yomitanSafariPopupRpc: true, type: 'result', clientId, id, result});
}

describe('SafariFrameClient', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        window = new JSDOM('<!DOCTYPE html>', {url: 'https://example.com/'}).window;
        vi.stubGlobal('window', window);
        // Safari content scripts can provide getRandomValues without randomUUID.
        vi.stubGlobal('crypto', {getRandomValues: (/** @type {Uint8Array} */ array) => array.fill(0xab)});
        frame = window.document.createElement('iframe');
        window.document.body.append(frame);
        postMessage = vi.fn();
        if (frame.contentWindow === null) { throw new Error('Missing test iframe window'); }
        vi.spyOn(frame.contentWindow, 'postMessage').mockImplementation(postMessage);
    });

    afterEach(() => {
        window.close();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    test('generates request IDs when randomUUID is unavailable', async () => {
        const client = new SafariFrameClient();
        await client.connect(frame, targetOrigin, 3, sendReady);
        const result = client.invoke('displayConfigure', {});
        const request = /** @type {{clientId: string, id: string}} */ (postMessage.mock.calls[0][0]);
        expect(request.clientId).toBe('ab'.repeat(16));
        expect(request.id).toBe(`${request.clientId}:1`);
        sendResult('configured');
        await expect(result).resolves.toBe('configured');
        client.disconnect();
    });

    test('receives a ready event during setup without losing the handshake', async () => {
        const client = new SafariFrameClient();
        await client.connect(frame, targetOrigin, 3, sendReady);
        expect(client.isConnected()).toBe(true);
        expect(client.frameId).toBe(3);
        expect(vi.getTimerCount()).toBe(0);
        client.disconnect();
    });

    test('ignores ready events from another frame or Safari extension', async () => {
        const client = new SafariFrameClient();
        const result = client.connect(frame, targetOrigin, 3, () => {});
        sendMessage({yomitanSafariPopupRpc: true, type: 'ready'}, null);
        sendMessage({yomitanSafariPopupRpc: true, type: 'ready'}, frame.contentWindow, 'safari-web-extension://other');
        expect(client.isConnected()).toBe(false);
        sendReady();
        await result;
        expect(client.isConnected()).toBe(true);
        client.disconnect();
    });

    test('removes the ready listener after handshake timeout', async () => {
        const client = new SafariFrameClient();
        const result = client.connect(frame, targetOrigin, 3, () => {}, 100);
        const rejection = expect(result).rejects.toThrow('handshake timed out');
        await vi.advanceTimersByTimeAsync(100);
        await rejection;
        sendReady();
        expect(client.isConnected()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        await expect(client.invoke('displayConfigure', {})).rejects.toThrow('not connected');
        client.disconnect();
    });

    test('cleans up a handshake when setup throws', async () => {
        const client = new SafariFrameClient();
        await expect(client.connect(frame, targetOrigin, 3, () => {
            throw new Error('Cannot navigate iframe');
        })).rejects.toThrow('Cannot navigate iframe');
        sendReady();
        expect(client.isConnected()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        client.disconnect();
    });

    test('disconnect cancels an incomplete handshake', async () => {
        const client = new SafariFrameClient();
        const result = client.connect(frame, targetOrigin, 3, () => {});
        const rejection = expect(result).rejects.toThrow('disconnected');
        client.disconnect();
        await rejection;
        sendReady();
        expect(client.isConnected()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('rejects requests from the previous connection before reconnecting', async () => {
        const client = new SafariFrameClient();
        await client.connect(frame, targetOrigin, 3, sendReady);
        const result = client.invoke('displayConfigure', {});
        const rejection = expect(result).rejects.toThrow('reconnected');
        await client.connect(frame, targetOrigin, 3, sendReady);
        await rejection;
        expect(vi.getTimerCount()).toBe(0);
        client.disconnect();
    });

    test('receives RPC results after connecting again following disconnect', async () => {
        const client = new SafariFrameClient();
        await client.connect(frame, targetOrigin, 3, sendReady);
        client.disconnect();
        await client.connect(frame, targetOrigin, 3, sendReady);
        const result = client.invoke('displayConfigure', {});
        sendResult('configured');
        await expect(result).resolves.toBe('configured');
        expect(vi.getTimerCount()).toBe(0);
        client.disconnect();
    });

    test('cleans up an RPC request when postMessage throws', async () => {
        const client = new SafariFrameClient();
        await client.connect(frame, targetOrigin, 3, sendReady);
        postMessage.mockImplementation(() => { throw new Error('Data clone failed'); });
        await expect(client.invoke('displayConfigure', {})).rejects.toThrow('Data clone failed');
        expect(vi.getTimerCount()).toBe(0);
        client.disconnect();
    });

    test('ignores responses from a different source, client or extension origin', async () => {
        const client = new SafariFrameClient();
        await client.connect(frame, targetOrigin, 3, sendReady);
        const result = client.invoke('displayConfigure', {});
        const {clientId, id} = /** @type {{clientId: string, id: string}} */ (postMessage.mock.calls[0][0]);
        sendMessage({yomitanSafariPopupRpc: true, type: 'result', clientId, id}, null);
        sendMessage({yomitanSafariPopupRpc: true, type: 'result', clientId: 'other', id});
        sendMessage({yomitanSafariPopupRpc: true, type: 'result', clientId, id}, frame.contentWindow, 'safari-web-extension://other');
        expect(vi.getTimerCount()).toBe(1);
        sendResult('configured');
        await expect(result).resolves.toBe('configured');
        client.disconnect();
    });

    test('times out unanswered RPC requests and ignores late results', async () => {
        const client = new SafariFrameClient();
        await client.connect(frame, targetOrigin, 3, sendReady);
        const result = client.invoke('displayConfigure', {});
        const rejection = expect(result).rejects.toThrow('RPC timed out: displayConfigure');
        await vi.advanceTimersByTimeAsync(10000);
        await rejection;
        sendResult('late');
        expect(vi.getTimerCount()).toBe(0);
        client.disconnect();
    });
});
