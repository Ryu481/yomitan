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

const STORAGE_KEY = 'yomitan-ios-onscreen-toggle-position';
const MOVE_THRESHOLD = 8;

export class IosOnscreenToggle {
    /**
     * @param {(active: boolean) => void} onActiveChanged
     */
    constructor(onActiveChanged) {
        /** @type {(active: boolean) => void} */
        this._onActiveChanged = onActiveChanged;
        /** @type {?HTMLButtonElement} */
        this._node = null;
        /** @type {boolean} */
        this._active = false;
        /** @type {boolean} */
        this._enabled = false;
        /** @type {?{pointerId: number, startX: number, startY: number, left: number, top: number, moved: boolean}} */
        this._drag = null;
        /** @type {?MutationObserver} */
        this._frontObserver = null;
        /** @type {number} */
        this._bringToFrontAnimationFrame = 0;
    }

    /** @type {?HTMLElement} */
    get node() { return this._node; }

    /** @type {boolean} */
    get active() { return this._active; }

    /**
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
        if (this._enabled === enabled) { return; }
        this._enabled = enabled;
        if (enabled) {
            this._create();
        } else {
            this.setActive(false);
            this._remove();
        }
    }

    /**
     * @param {boolean} active
     */
    setActive(active) {
        if (this._active === active) { return; }
        this._active = active;
        this._updateState();
        this._onActiveChanged(active);
    }

    /** */
    _create() {
        if (this._node !== null || document.body === null) { return; }

        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'yomitan-ios-onscreen-toggle';
        node.setAttribute('aria-label', 'Toggle Yomitan scanning');
        node.title = 'Toggle Yomitan scanning';

        const image = document.createElement('img');
        image.alt = '';
        image.draggable = false;
        image.src = chrome.runtime.getURL('/images/yomitan-icon.svg');
        node.appendChild(image);

        Object.assign(node.style, {
            position: 'fixed',
            left: '16px',
            top: '80px',
            width: '44px',
            height: '44px',
            padding: '0',
            border: '0',
            background: 'transparent',
            boxShadow: 'none',
            touchAction: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitUserDrag: 'none',
            cursor: 'pointer',
        });
        node.style.setProperty('z-index', '2147483647', 'important');

        Object.assign(image.style, {
            display: 'block',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            transition: 'opacity 120ms ease-in-out, filter 120ms ease-in-out',
        });

        node.addEventListener('pointerdown', this._onPointerDown.bind(this), true);
        node.addEventListener('pointermove', this._onPointerMove.bind(this), true);
        node.addEventListener('pointerup', this._onPointerUp.bind(this), true);
        node.addEventListener('pointercancel', this._onPointerCancel.bind(this), true);
        node.addEventListener('click', this._onClick.bind(this), true);

        this._node = node;
        document.body.appendChild(node);
        this._restorePosition();
        this._updateState();
        this._startFrontGuard();
        this.bringToFront();
    }

    /** */
    _remove() {
        if (this._node === null) { return; }
        this._stopFrontGuard();
        this._node.remove();
        this._node = null;
        this._drag = null;
    }

    /** */
    _updateState() {
        if (this._node === null) { return; }
        this._node.dataset.active = `${this._active}`;
        const image = this._node.querySelector('img');
        if (image === null) { return; }
        image.style.opacity = this._active ? '1' : '0.45';
        image.style.filter = this._active ? 'none' : 'grayscale(1) saturate(0.2)';
    }

    /** */
    bringToFront() {
        if (this._node === null || document.body === null) { return; }
        this._node.style.setProperty('z-index', '2147483647', 'important');
        if (this._node.parentNode !== document.body) {
            document.body.appendChild(this._node);
            return;
        }
        if (document.body.lastElementChild !== this._node) {
            document.body.appendChild(this._node);
        }
    }

    /** */
    _startFrontGuard() {
        if (this._frontObserver !== null || document.documentElement === null) { return; }
        this._frontObserver = new MutationObserver(() => this._scheduleBringToFront());
        this._frontObserver.observe(document.documentElement, {childList: true, subtree: true});
    }

    /** */
    _stopFrontGuard() {
        if (this._frontObserver !== null) {
            this._frontObserver.disconnect();
            this._frontObserver = null;
        }
        if (this._bringToFrontAnimationFrame !== 0) {
            cancelAnimationFrame(this._bringToFrontAnimationFrame);
            this._bringToFrontAnimationFrame = 0;
        }
    }

    /** */
    _scheduleBringToFront() {
        if (this._bringToFrontAnimationFrame !== 0) { return; }
        this._bringToFrontAnimationFrame = requestAnimationFrame(() => {
            this._bringToFrontAnimationFrame = 0;
            this.bringToFront();
        });
    }

    /** */
    _restorePosition() {
        if (this._node === null) { return; }
        try {
            const value = localStorage.getItem(STORAGE_KEY);
            if (value === null) { return; }
            const position = JSON.parse(value);
            if (typeof position.left !== 'number' || typeof position.top !== 'number') { return; }
            this._setPosition(position.left, position.top);
        } catch (e) {
            // Ignore malformed local storage values.
        }
    }

    /** */
    _savePosition() {
        if (this._node === null) { return; }
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                left: Number.parseFloat(this._node.style.left),
                top: Number.parseFloat(this._node.style.top),
            }));
        } catch (e) {
            // Ignore storage failures in private browsing or restricted contexts.
        }
    }

    /**
     * @param {number} left
     * @param {number} top
     */
    _setPosition(left, top) {
        if (this._node === null) { return; }
        const {innerWidth, innerHeight} = window;
        const width = this._node.offsetWidth || 44;
        const height = this._node.offsetHeight || 44;
        const nextLeft = Math.min(Math.max(0, left), Math.max(0, innerWidth - width));
        const nextTop = Math.min(Math.max(0, top), Math.max(0, innerHeight - height));
        this._node.style.left = `${nextLeft}px`;
        this._node.style.top = `${nextTop}px`;
    }

    /**
     * @param {PointerEvent} e
     */
    _onPointerDown(e) {
        if (this._node === null) { return; }
        e.preventDefault();
        e.stopPropagation();
        this._node.setPointerCapture(e.pointerId);
        const rect = this._node.getBoundingClientRect();
        this._drag = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            left: rect.left,
            top: rect.top,
            moved: false,
        };
    }

    /**
     * @param {PointerEvent} e
     */
    _onPointerMove(e) {
        if (this._node === null || this._drag === null || this._drag.pointerId !== e.pointerId) { return; }
        e.preventDefault();
        e.stopPropagation();
        const dx = e.clientX - this._drag.startX;
        const dy = e.clientY - this._drag.startY;
        if (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD) {
            this._drag.moved = true;
        }
        this._setPosition(this._drag.left + dx, this._drag.top + dy);
    }

    /**
     * @param {PointerEvent} e
     */
    _onPointerUp(e) {
        if (this._node === null || this._drag === null || this._drag.pointerId !== e.pointerId) { return; }
        e.preventDefault();
        e.stopPropagation();
        this._node.releasePointerCapture(e.pointerId);
        const moved = this._drag.moved;
        this._drag = null;
        this._savePosition();
        if (!moved) {
            this.setActive(!this._active);
        }
    }

    /**
     * @param {PointerEvent} e
     */
    _onPointerCancel(e) {
        if (this._node === null || this._drag === null || this._drag.pointerId !== e.pointerId) { return; }
        e.preventDefault();
        e.stopPropagation();
        this._drag = null;
    }

    /**
     * @param {MouseEvent} e
     */
    _onClick(e) {
        e.preventDefault();
        e.stopPropagation();
    }
}
