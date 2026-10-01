/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

import {webcrypto} from 'node:crypto';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {PopupFactory} from '../ext/js/app/popup-factory.js';
import {PopupProxy} from '../ext/js/app/popup-proxy.js';
import {Popup} from '../ext/js/app/popup.js';
import {createDomTest} from './fixtures/dom-test.js';

const domTest = createDomTest();

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Safari parent-frame RPC', () => {
    test('can be imported without a window or crypto.randomUUID', async () => {
        vi.resetModules();
        vi.stubGlobal('window', void 0);
        vi.stubGlobal('crypto', {getRandomValues: webcrypto.getRandomValues.bind(webcrypto)});

        const rpc = await import('../ext/js/comm/safari-cross-frame-rpc.js');

        expect(rpc.isSafariPopupIframeContext()).toBe(false);
    });

    domTest('only the factory hosting the source iframe answers an invocation', async ({window}) => {
        const iframe = window.document.createElement('iframe');
        window.document.body.appendChild(iframe);
        const source = /** @type {Window} */ (iframe.contentWindow);
        const postMessage = vi.spyOn(source, 'postMessage').mockImplementation(() => {});
        const ownerHide = vi.fn();
        const otherHide = vi.fn(() => { throw new Error('Invalid popup ID popup'); });
        const invokeLocal = vi.fn();
        const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({crossFrame: {invokeLocal}}));
        const {prepareSafariCrossFrameRpcResponder} = await import('../ext/js/comm/safari-cross-frame-rpc.js');
        const stopOther = prepareSafariCrossFrameRpcResponder(application, {
            popupFactory: /** @type {PopupFactory} */ (/** @type {unknown} */ ({
                isPopupFrame: () => false,
                _onApiHide: otherHide,
            })),
        });
        const stopOwner = prepareSafariCrossFrameRpcResponder(application, {
            popupFactory: /** @type {PopupFactory} */ (/** @type {unknown} */ ({
                isPopupFrame: (/** @type {MessageEventSource} */ candidate) => candidate === source,
                _onApiHide: ownerHide,
            })),
        });

        try {
            window.dispatchEvent(new window.MessageEvent('message', {
                source,
                origin: 'safari-web-extension://extension',
                data: {
                    yomitanSafariCrossFrameRpc: true,
                    type: 'invoke',
                    action: 'popupFactoryHide',
                    params: {id: 'popup', changeFocus: true},
                    clientId: 'client',
                    id: 'request',
                },
            }));

            await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
            expect(ownerHide).toHaveBeenCalledWith({id: 'popup', changeFocus: true});
            expect(otherHide).not.toHaveBeenCalled();
            expect(invokeLocal).not.toHaveBeenCalled();
            expect(postMessage).toHaveBeenCalledWith({
                yomitanSafariCrossFrameRpc: true,
                type: 'result',
                clientId: 'client',
                id: 'request',
                result: void 0,
                error: null,
            }, 'safari-web-extension://extension');
        } finally {
            stopOwner();
            stopOther();
        }
    });

    domTest('preserves errors from the owning factory', async ({window}) => {
        const iframe = window.document.createElement('iframe');
        window.document.body.appendChild(iframe);
        const source = /** @type {Window} */ (iframe.contentWindow);
        const postMessage = vi.spyOn(source, 'postMessage').mockImplementation(() => {});
        const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({}));
        const {prepareSafariCrossFrameRpcResponder} = await import('../ext/js/comm/safari-cross-frame-rpc.js');
        const stop = prepareSafariCrossFrameRpcResponder(application, {
            popupFactory: /** @type {PopupFactory} */ (/** @type {unknown} */ ({
                isPopupFrame: () => true,
                _onApiHide: () => { throw new Error('Invalid popup ID unknown'); },
            })),
        });

        try {
            window.dispatchEvent(new window.MessageEvent('message', {
                source,
                origin: 'null',
                data: {
                    yomitanSafariCrossFrameRpc: true,
                    type: 'invoke',
                    action: 'popupFactoryHide',
                    params: {id: 'unknown', changeFocus: false},
                    clientId: 'client',
                    id: 'request',
                },
            }));

            await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
            expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({error: 'Invalid popup ID unknown'}), '*');
        } finally {
            stop();
        }
    });

    domTest('creates a proxy in Safari even when the popup and owner have the same frame ID', async ({window}) => {
        const iframe = window.document.createElement('iframe');
        window.document.body.appendChild(iframe);
        const childWindow = /** @type {Window} */ (iframe.contentWindow);
        const parentWindow = childWindow.parent;
        vi.stubGlobal('window', childWindow);
        vi.stubGlobal('location', {protocol: 'safari-web-extension:', pathname: '/popup.html'});
        vi.stubGlobal('crypto', {getRandomValues: webcrypto.getRandomValues.bind(webcrypto)});
        const invoke = vi.fn();
        const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({frameId: 0, crossFrame: {invoke}}));
        const popupFactory = new PopupFactory(application);
        const postMessage = vi.spyOn(parentWindow, 'postMessage').mockImplementation((/** @type {{clientId: string, id: string}} */ data) => {
            childWindow.dispatchEvent(new window.MessageEvent('message', {
                source: parentWindow,
                data: {
                    yomitanSafariCrossFrameRpc: true,
                    type: 'result',
                    clientId: data.clientId,
                    id: data.id,
                    result: {id: 'owned-child', depth: 1, frameId: 0},
                },
            }));
        });

        const popupPromise = popupFactory.getOrCreatePopup({frameId: 0, parentPopupId: 'owned-parent', childrenSupported: true});
        expect(postMessage).toHaveBeenCalledTimes(1);
        const popup = await popupPromise;
        await popup.hide(false);

        expect(popup).toBeInstanceOf(PopupProxy);
        expect(popup.id).toBe('owned-child');
        expect(popup.depth).toBe(1);
        expect(invoke).not.toHaveBeenCalled();
        expect(postMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
            action: 'popupFactoryGetOrCreatePopup',
            params: {id: null, parentPopupId: 'owned-parent', frameId: 0, childrenSupported: true},
        }), '*');
        expect(postMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
            action: 'popupFactoryHide',
            params: {id: 'owned-child', changeFocus: false},
        }), '*');
    });

    domTest('uses normal local popups for other extension protocols', async ({window}) => {
        const iframe = window.document.createElement('iframe');
        window.document.body.appendChild(iframe);
        vi.stubGlobal('window', iframe.contentWindow);
        vi.stubGlobal('location', {protocol: 'moz-extension:', pathname: '/popup.html'});
        vi.stubGlobal('chrome', {runtime: {getURL: () => 'moz-extension://extension/'}});
        vi.spyOn(Popup.prototype, 'prepare').mockImplementation(() => {});
        const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({frameId: 0, crossFrame: {}}));
        const popupFactory = new PopupFactory(application);

        const popup = await popupFactory.getOrCreatePopup({frameId: 0, parentPopupId: 'parent'});

        expect(popup).toBeInstanceOf(Popup);
        window.document.body.appendChild(/** @type {Popup} */ (popup).container);
        expect(popupFactory.isPopupFrame(/** @type {Window} */ (/** @type {Popup} */ (popup).frameContentWindow))).toBe(true);
        expect(popupFactory.isPopupFrame(/** @type {Window} */ (iframe.contentWindow))).toBe(false);
    });

    domTest('rejects a failed postMessage immediately and clears its timeout', async ({window}) => {
        vi.resetModules();
        const iframe = window.document.createElement('iframe');
        window.document.body.appendChild(iframe);
        const childWindow = /** @type {Window} */ (iframe.contentWindow);
        vi.stubGlobal('window', childWindow);
        vi.spyOn(childWindow.parent, 'postMessage').mockImplementation(() => {
            throw new Error('parent unavailable');
        });
        const {invokeSafariParentFrame} = await import('../ext/js/comm/safari-cross-frame-rpc.js');
        vi.useFakeTimers();

        await expect(invokeSafariParentFrame('popupFactoryHide', {id: 'popup', changeFocus: false})).rejects.toThrow('parent unavailable');

        expect(vi.getTimerCount()).toBe(0);
    });
});
