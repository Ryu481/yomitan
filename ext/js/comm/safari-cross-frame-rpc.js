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
 *   popupFactory?: ?object
 * }|?object|null} options
 * @returns {() => void}
 */
export function prepareSafariCrossFrameRpcResponder(application, options = null) {
    let popupFactory = null;

    if (options !== null && typeof options === 'object') {
        if (Object.hasOwn(options, 'popupFactory')) {
            ({popupFactory = null} = options);
        } else {
            // Backwards compatibility:
            // allow prepareSafariCrossFrameRpcResponder(application, popupFactory)
            popupFactory = options;
        }
    }

    const onMessage = async (event) => {
        const data = event.data;
        if (data?.yomitanSafariCrossFrameRpc !== true || data?.type !== 'invoke') { return; }

        const source = event.source;
        if (source === null) { return; }

        let result;
        let error = null;

        try {
            result = await invokeSafariCrossFrameAction(
                application,
                popupFactory,
                data.action,
                data.params
            );
        } catch (e) {
            error = `${e?.message ?? e}`;
        }

        const targetOrigin = getPostMessageTargetOrigin(event);

        source.postMessage({
            yomitanSafariCrossFrameRpc: true,
            type: 'result',
            clientId: data.clientId,
            id: data.id,
            result,
            error,
        }, targetOrigin);
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
    ) ? event.origin : '*';
}

/**
 * @param {import('../application.js').Application} application
 * @param {?object} popupFactory
 * @param {string} action
 * @param {*} params
 * @returns {Promise<*>}
 */
async function invokeSafariCrossFrameAction(application, popupFactory, action, params) {
    const methodName = popupFactoryActionMethods.get(action);

    if (typeof methodName === 'string' && popupFactory !== null) {
        const method = popupFactory[methodName];

        if (typeof method !== 'function') {
            throw new Error(`Unsupported Safari popup factory action: ${action}`);
        }

        return await method.call(popupFactory, params);
    }

    return await application.crossFrame.invokeLocal(action, params);
}

export function isSafariPopupIframeContext() {
    try {
        return window.parent !== window && location.pathname.endsWith('/popup.html');
    } catch {
        return false;
    }
}

let nextId = 0;
const clientId = crypto.randomUUID();
const pending = new Map();

/**
 * Invokes a Safari parent-frame RPC action.
 *
 * This is used from popup.html iframe contexts where Safari's normal extension
 * cross-frame port communication is unreliable.
 *
 * @param {string} action
 * @param {*} params
 * @returns {Promise<*>}
 */
export function invokeSafariParentFrame(action, params) {
    const id = `${clientId}:${++nextId}`;

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Safari parent-frame RPC timed out: ${action}`));
        }, 10000);

        pending.set(id, {resolve, reject, timeout});

        window.parent.postMessage({
            yomitanSafariCrossFrameRpc: true,
            type: 'invoke',
            clientId,
            id,
            action,
            params,
        }, '*');
    });
}

window.addEventListener('message', (event) => {
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
}, false);