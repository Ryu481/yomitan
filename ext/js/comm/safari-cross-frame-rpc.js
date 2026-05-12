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
            params
        }, '*');
    });
}

window.addEventListener('message', (event) => {
    const data = event.data;
    if (data?.yomitanSafariCrossFrameRpc !== true || data?.type !== 'result') { return; }
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
});
