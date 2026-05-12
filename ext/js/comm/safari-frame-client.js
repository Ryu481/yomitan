export class SafariFrameClient {
    constructor() {
        this._frame = null;
        this._targetOrigin = null;
        this._frameId = 0;
        this._connected = false;
        this._nextId = 0;
        this._pending = new Map();
        this._clientId = crypto.randomUUID();

        this._onMessage = this._onMessage.bind(this);
        window.addEventListener('message', this._onMessage);
    }

    get frameId() {
        return this._frameId;
    }

    isConnected() {
        return this._connected;
    }

    async connect(frame, targetOrigin, frameId, setupFrame) {
        this._frame = frame;
        this._targetOrigin = targetOrigin;
        this._frameId = frameId;

        setupFrame(frame);

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Safari popup iframe handshake timed out'));
            }, 10000);

            const onReady = (event) => {
                const data = event.data;

                if (data?.yomitanSafariPopupRpc !== true || data?.type !== 'ready') {
                    return;
                }

                if (!this._isExpectedOrigin(event.origin)) {
                    console.warn('[SafariFrameClient] ready from unexpected origin', {
                        eventOrigin: event.origin,
                        expectedOrigin: this._targetOrigin
                    });
                    return;
                }

                console.log('[SafariFrameClient] handshake ready received');

                window.removeEventListener('message', onReady);
                clearTimeout(timeout);
                this._clearPending(new Error('Safari popup iframe reconnected'));
                this._connected = true;
                resolve();
            };

            window.addEventListener('message', onReady);
        });
    }

    createMessage(message) {
        return {
            yomitanSafariPopupFrameClientMessage: true,
            data: message
        };
    }

    invoke(action, params) {
        if (!this._connected || this._frame?.contentWindow == null) {
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

            this._frame.contentWindow.postMessage({
                yomitanSafariPopupRpc: true,
                type: 'invoke',
                clientId: this._clientId,
                id,
                apiAction: action,
                params
            }, '*');

        });
    }

    disconnect() {
        window.removeEventListener('message', this._onMessage);

        this._clearPending(new Error('Safari popup iframe disconnected'));
        this._connected = false;
        this._frame = null;
    }
    
    _clearPending(error) {
        for (const {reject, timeout} of this._pending.values()) {
            clearTimeout(timeout);
            reject(error);
        }
        this._pending.clear();
    }

    _onMessage(event) {
        const data = event.data;

        if (data?.yomitanSafariPopupRpc !== true || data?.type !== 'result') {
            return;
        }

        if (!this._isExpectedOrigin(event.origin)) {
            console.warn('[SafariFrameClient] result from unexpected origin', {
                eventOrigin: event.origin,
                expectedOrigin: this._targetOrigin
            });
            return;
        }
        if (data.clientId !== this._clientId) {
            return;
        }

        const item = this._pending.get(data.id);
        if (item === void 0) {
            console.warn('[SafariFrameClient] result for unknown RPC id', data.id);
            return;
        }

        this._pending.delete(data.id);
        clearTimeout(item.timeout);

        if (data.error) {
            item.reject(new Error(data.error));
        } else {
            item.resolve(data.result);
        }
    }

    _isExpectedOrigin(origin) {
        return this._normalizeOrigin(origin) === this._normalizeOrigin(this._targetOrigin);
    }

    _normalizeOrigin(origin) {
        try {
            return new URL(origin).origin.toLowerCase();
        } catch {
            return String(origin).toLowerCase();
        }
    }
}
