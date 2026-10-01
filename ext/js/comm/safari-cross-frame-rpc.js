/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2019-2022  Yomichan Authors
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

import {toError} from '../core/to-error.js';
import {deferPromise, generateId} from '../core/utilities.js';

/**
 * @typedef {{
 *   yomitanSafariCrossFrameRpc: true,
 *   type: 'invoke',
 *   clientId: string,
 *   id: string,
 *   action: import('cross-frame-api').ApiNames,
 *   params: import('cross-frame-api').ApiParams<import('cross-frame-api').ApiNames>,
 * }} SafariInvokeMessage
 */

/**
 * @typedef {{
 *   yomitanSafariCrossFrameRpc: true,
 *   type: 'result',
 *   clientId: string,
 *   id: string,
 *   result?: unknown,
 *   error?: ?string,
 * }} SafariResultMessage
 */

/** @type {Map<string, keyof import('../app/popup-factory.js').PopupFactory>} */
const popupFactoryActionMethods = new Map([
    ['popupFactoryGetOrCreatePopup', '_onApiGetOrCreatePopup'],
    ['popupFactorySetOptionsContext', '_onApiSetOptionsContext'],
    ['popupFactoryHide', '_onApiHide'],
    ['popupFactoryIsVisible', '_onApiIsVisibleAsync'],
    ['popupFactorySetVisibleOverride', '_onApiSetVisibleOverride'],
    ['popupFactoryClearVisibleOverride', '_onApiClearVisibleOverride'],
    ['popupFactoryContainsPoint', '_onApiContainsPoint'],
    ['popupFactoryShowContent', '_onApiShowContent'],
    ['popupFactorySetCustomCss', '_onApiSetCustomCss'],
    ['popupFactoryClearAutoPlayTimer', '_onApiClearAutoPlayTimer'],
    ['popupFactorySetContentScale', '_onApiSetContentScale'],
    ['popupFactoryUpdateTheme', '_onApiUpdateTheme'],
    ['popupFactorySetCustomOuterCss', '_onApiSetCustomOuterCss'],
    ['popupFactoryGetFrameSize', '_onApiGetFrameSize'],
    ['popupFactorySetFrameSize', '_onApiSetFrameSize'],
    ['popupFactoryIsPointerOver', '_onApiIsPointerOver'],
]);

/**
 * @param {import('../application.js').Application} application
 * @param {{
 *   popupFactory?: ?import('../app/popup-factory.js').PopupFactory
 * }|import('../app/popup-factory.js').PopupFactory|null} options
 * @returns {() => void}
 */
export function prepareSafariCrossFrameRpcResponder(application, options = null) {
    /** @type {?import('../app/popup-factory.js').PopupFactory} */
    let popupFactory = null;

    if (options !== null && typeof options === 'object') {
        if ('popupFactory' in options) {
            ({popupFactory = null} = options);
        } else {
            // Backwards compatibility:
            // allow prepareSafariCrossFrameRpcResponder(application, popupFactory)
            popupFactory = /** @type {import('../app/popup-factory.js').PopupFactory} */ (options);
        }
    }

    /** @param {MessageEvent<SafariInvokeMessage>} event */
    const onMessage = async (event) => {
        const data = event.data;
        if (data?.yomitanSafariCrossFrameRpc !== true || data?.type !== 'invoke') { return; }

        const source = /** @type {?Window} */ (event.source);
        if (source === null) { return; }
        // A document may have more than one PopupFactory. Only the factory
        // hosting this iframe may answer, otherwise its popup IDs are unknown.
        if (popupFactory !== null && !popupFactory.isPopupFrame(source)) { return; }

        let result;
        let error = null;

        try {
            result = await invokeSafariCrossFrameAction(
                application,
                popupFactory,
                data.action,
                data.params,
            );
        } catch (e) {
            error = toError(e).message;
        }

        const targetOrigin = getPostMessageTargetOrigin(event);

        try {
            source.postMessage({
                yomitanSafariCrossFrameRpc: true,
                type: 'result',
                clientId: data.clientId,
                id: data.id,
                result,
                error,
            }, targetOrigin);
        } catch (e) {
            // The iframe can navigate or be removed while its action is being
            // handled. There is no longer a recipient for this result.
            if (e instanceof DOMException && (e.name === 'SecurityError' || e.name === 'InvalidStateError')) { return; }
            throw e;
        }
    };

    window.addEventListener('message', onMessage, false);

    return () => {
        window.removeEventListener('message', onMessage, false);
    };
}

/**
 * @param {MessageEvent} event
 * @returns {string}
 */
function getPostMessageTargetOrigin(event) {
    return (
        typeof event.origin === 'string' &&
        event.origin.length > 0 &&
        event.origin !== 'null'
    ) ?
event.origin :
'*';
}

/**
 * @param {import('../application.js').Application} application
 * @param {?import('../app/popup-factory.js').PopupFactory} popupFactory
 * @param {import('cross-frame-api').ApiNames} action
 * @param {import('cross-frame-api').ApiParams<import('cross-frame-api').ApiNames>} params
 * @returns {Promise<unknown>}
 */
async function invokeSafariCrossFrameAction(application, popupFactory, action, params) {
    const methodName = popupFactoryActionMethods.get(action);

    if (typeof methodName === 'string' && popupFactory !== null) {
        const method = popupFactory[methodName];

        if (typeof method !== 'function') {
            throw new Error(`Unsupported Safari popup factory action: ${action}`);
        }

        return await /** @type {(params: unknown) => unknown} */ (method).call(popupFactory, params);
    }

    return await application.crossFrame.invokeLocal(action, params);
}

/** @returns {boolean} */
export function isSafariPopupIframeContext() {
    try {
        return (
            window.parent !== window &&
            location.protocol === 'safari-web-extension:' &&
            location.pathname.endsWith('/popup.html')
        );
    } catch {
        return false;
    }
}

let nextId = 0;
/** @type {?string} */
let clientId = null;
/** @type {Map<string, {resolve: (value: unknown) => void, reject: (reason: Error) => void, timeout: ReturnType<typeof setTimeout>}>} */
const pending = new Map();

/**
 * Invokes a Safari parent-frame RPC action.
 *
 * This is used from popup.html iframe contexts where Safari's normal extension
 * cross-frame port communication is unreliable.
 * @template {import('cross-frame-api').ApiNames} TName
 * @param {TName} action
 * @param {import('cross-frame-api').ApiParams<TName>} params
 * @returns {Promise<import('cross-frame-api').ApiReturn<TName>>}
 */
export function invokeSafariParentFrame(action, params) {
    if (clientId === null) {
        clientId = generateId(16);
        window.addEventListener('message', onParentFrameMessage, false);
    }
    const id = `${clientId}:${++nextId}`;

    const {promise, resolve, reject} = deferPromise();
    const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Safari parent-frame RPC timed out: ${action}`));
    }, 10000);

    pending.set(id, {resolve, reject, timeout});

    try {
        window.parent.postMessage({
            yomitanSafariCrossFrameRpc: true,
            type: 'invoke',
            clientId,
            id,
            action,
            params,
        }, '*');
    } catch (e) {
        pending.delete(id);
        clearTimeout(timeout);
        reject(toError(e));
    }
    return /** @type {Promise<import('cross-frame-api').ApiReturn<TName>>} */ (promise);
}

/** @param {MessageEvent<SafariResultMessage>} event */
function onParentFrameMessage(event) {
    const data = event.data;
    if (data?.yomitanSafariCrossFrameRpc !== true || data?.type !== 'result') { return; }
    if (event.source !== window.parent) { return; }
    if (data.clientId !== clientId) { return; }

    const item = pending.get(data.id);
    if (item === void 0) { return; }

    pending.delete(data.id);
    clearTimeout(item.timeout);

    if (data.error) {
        item.reject(new Error(data.error));
    } else {
        item.resolve(data.result);
    }
}
