// --- addEventListener monkey-patch for interactive listener detection ---
// Must run BEFORE any framework (React/Vue/Svelte) mounts, so placed at very top.
// Tracks by callback identity (type + listener + capture) so removeEventListener
// with a non-matching handler doesn't incorrectly remove elements from the set.
const _elementsWithListeners = new WeakSet<Element>();
const INTERACTIVE_LISTENER_TYPES = new Set([
    'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
    'touchstart', 'touchend', 'keydown', 'keyup', 'keypress'
]);

if (typeof window !== 'undefined' && !(window as any).__TAURI_MCP_LISTENER_PATCH__) {
    const _origAdd = EventTarget.prototype.addEventListener;
    const _origRemove = EventTarget.prototype.removeEventListener;
    // Map<Element, Map<"type|capture", Set<listener>>>
    const _listenerSets = new WeakMap<Element, Map<string, Set<any>>>();

    function _captureFlag(options: any): boolean {
        if (typeof options === 'boolean') return options;
        if (options && typeof options === 'object') return !!options.capture;
        return false;
    }

    EventTarget.prototype.addEventListener = function(type: string, listener: any, options?: any) {
        if (INTERACTIVE_LISTENER_TYPES.has(type) && this instanceof Element && listener) {
            const key = `${type}|${_captureFlag(options) ? '1' : '0'}`;
            let map = _listenerSets.get(this);
            if (!map) { map = new Map(); _listenerSets.set(this, map); }
            let set = map.get(key);
            if (!set) { set = new Set(); map.set(key, set); }
            set.add(listener);
            _elementsWithListeners.add(this);
        }
        return _origAdd.call(this, type, listener, options);
    };

    EventTarget.prototype.removeEventListener = function(type: string, listener: any, options?: any) {
        if (INTERACTIVE_LISTENER_TYPES.has(type) && this instanceof Element && listener) {
            const map = _listenerSets.get(this);
            if (map) {
                const key = `${type}|${_captureFlag(options) ? '1' : '0'}`;
                const set = map.get(key);
                if (set) {
                    set.delete(listener);
                    if (set.size === 0) map.delete(key);
                }
                if (map.size === 0) {
                    _elementsWithListeners.delete(this);
                    _listenerSets.delete(this);
                }
            }
        }
        return _origRemove.call(this, type, listener, options);
    };

    (window as any).__TAURI_MCP_LISTENER_PATCH__ = true;
}

import { emit } from '@tauri-apps/api/event'; // For emitting the response
import { invoke } from '@tauri-apps/api/core'; // For manage_ipc invoke passthrough
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow'; // For window-specific listener

// Track the unlisten functions for cleanup
let domContentUnlistenFunction: (() => void) | null = null;
let pageMapUnlistenFunction: (() => void) | null = null;
let localStorageUnlistenFunction: (() => void) | null = null;
let jsExecutionUnlistenFunction: (() => void) | null = null;
let elementPositionUnlistenFunction: (() => void) | null = null;
let sendTextToElementUnlistenFunction: (() => void) | null = null;
let getPageStateUnlistenFunction: (() => void) | null = null;
let navigateBackUnlistenFunction: (() => void) | null = null;
let scrollPageUnlistenFunction: (() => void) | null = null;
let fillFormUnlistenFunction: (() => void) | null = null;
let waitForUnlistenFunction: (() => void) | null = null;
let navigateWebviewUnlistenFunction: (() => void) | null = null;
let manageZoomUnlistenFunction: (() => void) | null = null;
let typeIntoFocusedUnlistenFunction: (() => void) | null = null;
let pressKeyUnlistenFunction: (() => void) | null = null;
let setFileInputUnlistenFunction: (() => void) | null = null;
let ipcInvokeUnlistenFunction: (() => void) | null = null;

// ---- Correlation ID helpers ----
// Extract the _correlationId from an event payload (injected by Rust's emit_and_wait).
function getCorrelationId(payload: any): string | null {
    if (typeof payload === 'object' && payload !== null && typeof payload._correlationId === 'string') {
        return payload._correlationId;
    }
    return null;
}

// Emit a response on the correlated event name: "{baseEventName}-{correlationId}"
async function emitResponse(baseEventName: string, correlationId: string | null, data: any): Promise<void> {
    if (correlationId) {
        await emit(`${baseEventName}-${correlationId}`, data);
    } else {
        // Fallback for requests without correlation IDs (should not happen with updated Rust)
        await emit(baseEventName, data);
    }
}

// Global ref map: stores numbered references to interactive elements from the last getPageMap call
let _pageMapRefElements: Map<number, Element> = new Map();

// Track the last focused element for cross-call focus persistence
let _lastFocusedElement: Element | null = null;

// Returns true if an element can accept typed text input
function isTypeable(el: Element): boolean {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    if (el.hasAttribute('data-lexical-editor') || el.hasAttribute('data-slate-editor')) return true;
    if (el.closest('[data-lexical-editor]') || el.closest('[data-slate-editor]')) return true;
    return false;
}

// Set up a capture-phase focus listener to track the last focused typeable element
if (typeof document !== 'undefined') {
    document.addEventListener('focus', (e) => {
        const target = e.target;
        if (target && target instanceof Element && isTypeable(target)) {
            _lastFocusedElement = target;
        }
    }, true);
}

// Delta tracking: fingerprint → { ref, props } from the previous getPageMap(delta:true) call
let _previousPageMapFingerprints: Map<string, { ref: number; props: PageMapElement }> = new Map();
let _previousPageMapMaxRef: number = 0;

// Deduplication: track correlation IDs that have already been handled to prevent
// duplicate processing when listeners are accidentally registered twice
// (React StrictMode, HMR, SPA navigation)
const _handledCorrelationIds = new Set<string>();

export async function setupPluginListeners() {
    // Clean up any existing listeners to prevent duplicate registration
    // (can happen with React StrictMode, HMR, or SPA navigation)
    await cleanupPluginListeners();

    const currentWindow: WebviewWindow = getCurrentWebviewWindow();
    domContentUnlistenFunction = await currentWindow.listen('got-dom-content', handleDomContentRequest);
    pageMapUnlistenFunction = await currentWindow.listen('get-page-map', handleGetPageMapRequest);
    localStorageUnlistenFunction = await currentWindow.listen('get-local-storage', handleLocalStorageRequest);
    jsExecutionUnlistenFunction = await currentWindow.listen('execute-js', handleJsExecutionRequest);
    elementPositionUnlistenFunction = await currentWindow.listen('get-element-position', handleGetElementPositionRequest);
    sendTextToElementUnlistenFunction = await currentWindow.listen('send-text-to-element', handleSendTextToElementRequest);
    getPageStateUnlistenFunction = await currentWindow.listen('get-page-state', handleGetPageStateRequest);
    navigateBackUnlistenFunction = await currentWindow.listen('navigate-back', handleNavigateBackRequest);
    scrollPageUnlistenFunction = await currentWindow.listen('scroll-page', handleScrollPageRequest);
    fillFormUnlistenFunction = await currentWindow.listen('fill-form', handleFillFormRequest);
    waitForUnlistenFunction = await currentWindow.listen('wait-for', handleWaitForRequest);
    navigateWebviewUnlistenFunction = await currentWindow.listen('navigate-webview', handleNavigateWebviewRequest);
    manageZoomUnlistenFunction = await currentWindow.listen('manage-zoom', handleManageZoomRequest);
    typeIntoFocusedUnlistenFunction = await currentWindow.listen('type-into-focused', handleTypeIntoFocusedRequest);
    pressKeyUnlistenFunction = await currentWindow.listen('press-key', handlePressKeyRequest);
    setFileInputUnlistenFunction = await currentWindow.listen('set-file-input', handleSetFileInputRequest);
    ipcInvokeUnlistenFunction = await currentWindow.listen('ipc-invoke', handleIpcInvokeRequest);

    console.log('TAURI-PLUGIN-MCP: All event listeners are set up on the current window.');
}

export async function cleanupPluginListeners() {
    if (domContentUnlistenFunction) {
        domContentUnlistenFunction();
        domContentUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "got-dom-content" has been removed.');
    }
    
    if (pageMapUnlistenFunction) {
        pageMapUnlistenFunction();
        pageMapUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "get-page-map" has been removed.');
    }

    if (localStorageUnlistenFunction) {
        localStorageUnlistenFunction();
        localStorageUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "get-local-storage" has been removed.');
    }

    if (jsExecutionUnlistenFunction) {
        jsExecutionUnlistenFunction();
        jsExecutionUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "execute-js" has been removed.');
    }
    
    if (elementPositionUnlistenFunction) {
        elementPositionUnlistenFunction();
        elementPositionUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "get-element-position" has been removed.');
    }
    
    if (sendTextToElementUnlistenFunction) {
        sendTextToElementUnlistenFunction();
        sendTextToElementUnlistenFunction = null;
    }
    if (getPageStateUnlistenFunction) {
        getPageStateUnlistenFunction();
        getPageStateUnlistenFunction = null;
    }
    if (navigateBackUnlistenFunction) {
        navigateBackUnlistenFunction();
        navigateBackUnlistenFunction = null;
    }
    if (scrollPageUnlistenFunction) {
        scrollPageUnlistenFunction();
        scrollPageUnlistenFunction = null;
    }
    if (fillFormUnlistenFunction) {
        fillFormUnlistenFunction();
        fillFormUnlistenFunction = null;
    }
    if (waitForUnlistenFunction) {
        waitForUnlistenFunction();
        waitForUnlistenFunction = null;
    }
    if (navigateWebviewUnlistenFunction) {
        navigateWebviewUnlistenFunction();
        navigateWebviewUnlistenFunction = null;
    }
    if (manageZoomUnlistenFunction) {
        manageZoomUnlistenFunction();
        manageZoomUnlistenFunction = null;
    }
    if (typeIntoFocusedUnlistenFunction) {
        typeIntoFocusedUnlistenFunction();
        typeIntoFocusedUnlistenFunction = null;
    }
    if (pressKeyUnlistenFunction) {
        pressKeyUnlistenFunction();
        pressKeyUnlistenFunction = null;
    }
    if (setFileInputUnlistenFunction) {
        setFileInputUnlistenFunction();
        setFileInputUnlistenFunction = null;
    }
    if (ipcInvokeUnlistenFunction) {
        ipcInvokeUnlistenFunction();
        ipcInvokeUnlistenFunction = null;
    }
    console.log('TAURI-PLUGIN-MCP: All event listeners have been removed.');
}

async function handleGetElementPositionRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received get-element-position, payload:', event.payload);
    const correlationId = getCorrelationId(event.payload);

    try {
        const { selectorType, selectorValue, shouldClick = false } = event.payload;

        // Find the element based on the selector type
        let element = null;
        let debugInfo = [];

        switch (selectorType) {
            case 'ref':
                // Look up by numbered reference from get_page_map
                const refNum = parseInt(selectorValue, 10);
                element = getElementByRef(refNum);
                if (!element) {
                    debugInfo.push(`No element found with ref=${refNum}. Call get_page_map first to populate refs.`);
                }
                break;
            case 'id':
                element = document.getElementById(selectorValue);
                if (!element) {
                    debugInfo.push(`No element found with id="${selectorValue}"`);
                }
                break;
            case 'class':
                // Get the first element with the class
                const elemsByClass = document.getElementsByClassName(selectorValue);
                element = elemsByClass.length > 0 ? elemsByClass[0] : null;
                if (!element) {
                    debugInfo.push(`No elements found with class="${selectorValue}" (total matching: 0)`);
                } else if (elemsByClass.length > 1) {
                    debugInfo.push(`Found ${elemsByClass.length} elements with class="${selectorValue}", using the first one`);
                }
                break;
            case 'tag':
                // Get the first element with the tag name
                const elemsByTag = document.getElementsByTagName(selectorValue);
                element = elemsByTag.length > 0 ? elemsByTag[0] : null;
                if (!element) {
                    debugInfo.push(`No elements found with tag="${selectorValue}" (total matching: 0)`);
                } else if (elemsByTag.length > 1) {
                    debugInfo.push(`Found ${elemsByTag.length} elements with tag="${selectorValue}", using the first one`);
                }
                break;
            case 'css':
                // Any CSS selector — first match
                element = document.querySelector(selectorValue);
                if (!element) {
                    debugInfo.push(`No element found matching CSS selector "${selectorValue}"`);
                }
                break;
            case 'text':
                // Find element by text content
                element = findElementByText(selectorValue);
                if (!element) {
                    debugInfo.push(`No element found with text="${selectorValue}"`);
                    // Check if any element contains part of the text (for debugging)
                    const containingElements = Array.from(document.querySelectorAll('*'))
                        .filter(el => el.textContent && el.textContent.includes(selectorValue));

                    if (containingElements.length > 0) {
                        debugInfo.push(`Found ${containingElements.length} elements containing part of the text.`);
                        debugInfo.push(`First element with partial match: ${containingElements[0].tagName}, text="${containingElements[0].textContent?.trim()}"`);
                    }

                    // Check for similar inputs
                    const inputs = Array.from(document.querySelectorAll('input, textarea'));
                    const inputsWithSimilarPlaceholders = inputs
                        .filter(input =>
                            (input as HTMLInputElement).placeholder &&
                            (input as HTMLInputElement).placeholder.includes(selectorValue)
                        );

                    if (inputsWithSimilarPlaceholders.length > 0) {
                        debugInfo.push(`Found ${inputsWithSimilarPlaceholders.length} input elements with similar placeholders.`);
                        const firstMatch = inputsWithSimilarPlaceholders[0] as HTMLInputElement;
                        debugInfo.push(`First input with similar placeholder: ${firstMatch.tagName}, placeholder="${firstMatch.placeholder}"`);
                    }
                }
                break;
            default:
                throw new Error(`Unsupported selector type: ${selectorType}`);
        }
        
        if (!element) {
            throw new Error(`Element with ${selectorType}="${selectorValue}" not found. ${debugInfo.join(' ')}`);
        }
        
        // Get element position
        const rect = element.getBoundingClientRect();
        console.log('TAURI-PLUGIN-MCP: Element rect:', { 
            left: rect.left, 
            top: rect.top, 
            right: rect.right, 
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height
        });

        // Calculate center of the element in viewport-relative CSS pixels
        const elementViewportCssX = rect.left + (rect.width / 2);
        const elementViewportCssY = rect.top + (rect.height / 2);

        // Account for Webview Scrolling (CSS Pixels)
        const elementDocumentCssX = elementViewportCssX + window.scrollX;
        const elementDocumentCssY = elementViewportCssY + window.scrollY;
        
        // Always return the raw document coordinates (ideal for mouse_movement)
        const targetX = elementDocumentCssX;
        const targetY = elementDocumentCssY;
        
        console.log('TAURI-PLUGIN-MCP: Raw coordinates for mouse_movement:', { x: targetX, y: targetY });

        // Click the element if requested
        let clickResult = null;
        if (shouldClick) {
            clickResult = clickElement(element, elementViewportCssX, elementViewportCssY);
        }

        await emitResponse('get-element-position-response', correlationId, {
            success: true,
            data: {
                x: targetX,
                y: targetY,
                element: {
                    tag: element.tagName,
                    classes: element.className,
                    id: element.id,
                    text: element.textContent?.trim() || '',
                    placeholder: element instanceof HTMLInputElement ? element.placeholder : undefined
                },
                clicked: shouldClick,
                clickResult,
                debug: {
                    elementRect: rect,
                    viewportCenter: {
                        x: elementViewportCssX,
                        y: elementViewportCssY
                    },
                    documentCenter: {
                        x: elementDocumentCssX,
                        y: elementDocumentCssY
                    },
                    window: {
                        innerSize: {
                            width: window.innerWidth,
                            height: window.innerHeight
                        },
                        scrollPosition: {
                            x: window.scrollX,
                            y: window.scrollY
                        }
                    }
                }
            }
        });

    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling get-element-position request', error);
        await emitResponse('get-element-position-response', correlationId, {
            success: false,
            error: error instanceof Error ? error.toString() : String(error)
        }).catch(e => console.error('TAURI-PLUGIN-MCP: Error emitting error response', e));
    }
}

// Helper function to find an element by its text content
function findElementByText(text: string): Element | null {
    // Get all elements in the document
    const allElements = document.querySelectorAll('*');
    
    // First try exact text content matching
    for (const element of allElements) {
        // Check exact text content
        if (element.textContent && element.textContent.trim() === text) {
            return element;
        }
        
        // Check placeholder attribute (for input fields)
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            if (element.placeholder === text) {
                return element;
            }
        }
        
        // Check title attribute
        if (element.getAttribute('title') === text) {
            return element;
        }
        
        // Check aria-label attribute
        if (element.getAttribute('aria-label') === text) {
            return element;
        }
    }
    
    // If no exact match, try partial text content matching
    for (const element of allElements) {
        // Check if text is contained within the element's text
        if (element.textContent && element.textContent.trim().includes(text)) {
            return element;
        }
        
        // Check if text is contained within placeholder
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            if (element.placeholder && element.placeholder.includes(text)) {
                return element;
            }
        }
        
        // Check partial match in title attribute
        const title = element.getAttribute('title');
        if (title && title.includes(text)) {
            return element;
        }
        
        // Check partial match in aria-label attribute
        const ariaLabel = element.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.includes(text)) {
            return element;
        }
    }
    
    return null;
}

// Helper function to click an element
function clickElement(element: Element, centerX: number, centerY: number) {
    try {
        // If the resolved element is not itself interactive (common with
        // text matching, which finds the innermost element holding the
        // text), climb to the nearest interactive ancestor — many apps
        // attach their handler on a row/card container and ignore events
        // whose dispatch target is an inner presentational node.
        if (!isInteractive(element)) {
            let p: Element | null = element.parentElement;
            while (p && p !== document.body) {
                if (isInteractive(p)) {
                    console.log(`TAURI-PLUGIN-MCP: Click target <${element.tagName.toLowerCase()}> is not interactive; retargeting to ancestor <${p.tagName.toLowerCase()}${p.id ? '#' + p.id : ''}>`);
                    element = p;
                    break;
                }
                p = p.parentElement;
            }
        }

        // Explicitly focus the element before dispatching mouse events.
        // Synthetic dispatchEvent() does NOT trigger the browser's native focus
        // behavior the way a real user click does. Without this, document.activeElement
        // stays on <body> and the type_into_focused handler can't find the target.
        if (element instanceof HTMLElement) {
            element.focus();
        }

        // Update _lastFocusedElement so type_into_focused can recover focus
        // even if the app's click handler shifts focus elsewhere (e.g. closes
        // a dropdown, re-renders a component).
        if (isTypeable(element)) {
            _lastFocusedElement = element;
        }

        // Dispatch the full modern event sequence a real click produces:
        // pointerdown → mousedown → pointerup → mouseup → click.
        // Many component libraries (Radix, Headless UI, custom
        // pointer-event handlers) listen for PointerEvents and ignore
        // plain MouseEvents entirely — without pointerdown/pointerup
        // those elements never activate.
        const base = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: centerX,
            clientY: centerY,
            button: 0,
        };
        const pointerBase = {
            ...base,
            pointerId: 1,
            isPrimary: true,
            pointerType: 'mouse' as const,
        };

        element.dispatchEvent(new PointerEvent('pointerdown', { ...pointerBase, buttons: 1 }));
        element.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
        element.dispatchEvent(new PointerEvent('pointerup', { ...pointerBase, buttons: 0 }));
        element.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
        element.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0, detail: 1 }));

        return {
            success: true,
            elementTag: element.tagName,
            position: { x: centerX, y: centerY }
        };
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error clicking element:', error);
        return {
            success: false,
            error: error instanceof Error ? error.toString() : String(error)
        };
    }
}

async function handleDomContentRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received got-dom-content, payload:', event.payload);
    const correlationId = getCorrelationId(event.payload);

    try {
        const domContent = getDomContent();
        await emitResponse('got-dom-content-response', correlationId, domContent);
        console.log('TAURI-PLUGIN-MCP: Emitted got-dom-content-response');
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling dom content request', error);
        await emitResponse('got-dom-content-response', correlationId, '').catch(e =>
            console.error('TAURI-PLUGIN-MCP: Error emitting empty response', e)
        );
    }
}

function getDomContent(): string {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        const domContent = document.documentElement.outerHTML;
        console.log('TAURI-PLUGIN-MCP: DOM content fetched, length:', domContent.length);
        return domContent;
    } 
    
    console.warn('TAURI-PLUGIN-MCP: DOM not fully loaded when got-dom-content received. Returning empty content.');
    return '';
}

// --- Page Map (smart DOM serializer) ---

interface PageMapElement {
    ref: number;
    tag: string;
    interactive?: boolean;
    type?: string;
    text?: string;
    placeholder?: string;
    ariaLabel?: string;
    role?: string;
    href?: string;
    name?: string;
    id?: string;
    value?: string;
    checked?: boolean;
    disabled?: boolean;
    options?: string[];
    context?: string;
    parentRef?: number;
    depth?: number;
    /** False when the element or an ancestor is hidden (display:none, aria-hidden, etc.) */
    visible?: boolean;
}

interface PageMapOptions {
    includeContent?: boolean;
    includeMetadata?: boolean;
    interactiveOnly?: boolean;
    scopeSelector?: string | string[];
    maxDepth?: number;
    delta?: boolean;
    waitForStable?: boolean;
    quietMs?: number;
    maxWaitMs?: number;
}

interface PageMapDelta {
    added: number[];
    removed: number[];
    changed: number[];
}

interface PageMetadata {
    description?: string;
    openGraph?: Record<string, string>;
    jsonLd?: any[];
}

interface PageMapResult {
    url: string;
    title: string;
    viewport: { width: number; height: number };
    elements: PageMapElement[];
    content: string;
    metadata?: PageMetadata;
    scope?: string | string[];
    maxDepth?: number;
    delta?: PageMapDelta;
}

// Wait for DOM mutations to settle (no changes for `quietMs` milliseconds)
function waitForDomStable(quietMs: number = 300, maxWaitMs: number = 3000): Promise<void> {
    return new Promise((resolve) => {
        let resolved = false;
        let timer: ReturnType<typeof setTimeout>;

        function done() {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            clearTimeout(timeout);
            observer.disconnect();
            resolve();
        }

        const timeout = setTimeout(done, maxWaitMs);

        const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(done, quietMs);
        });

        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
        });

        // If no mutations happen at all, resolve after quietMs
        timer = setTimeout(done, quietMs);
    });
}

async function handleGetPageMapRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received get-page-map, payload:', event.payload);
    const correlationId = getCorrelationId(event.payload);

    try {
        const options = typeof event.payload === 'object' ? event.payload : {};

        // If wait_for_stable is requested, wait for DOM to settle first
        if (options.waitForStable) {
            const quietMs = typeof options.quietMs === 'number' ? options.quietMs : 300;
            const maxWaitMs = typeof options.maxWaitMs === 'number' ? options.maxWaitMs : 3000;
            console.log(`TAURI-PLUGIN-MCP: Waiting for DOM to stabilize (quiet=${quietMs}ms, max=${maxWaitMs}ms)`);
            await waitForDomStable(quietMs, maxWaitMs);
        }

        const result = getPageMap(options);
        await emitResponse('get-page-map-response', correlationId, JSON.stringify(result));
        console.log('TAURI-PLUGIN-MCP: Emitted get-page-map-response');
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling get-page-map request', error);
        await emitResponse('get-page-map-response', correlationId, JSON.stringify({
            url: window.location.href,
            title: document.title,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            elements: [],
            content: '',
            error: error instanceof Error ? error.message : String(error)
        })).catch(e =>
            console.error('TAURI-PLUGIN-MCP: Error emitting error response', e)
        );
    }
}

const NOISE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META', 'HEAD', 'BR', 'HR',
    'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'SLOT'
]);

const INTERACTIVE_TAGS = new Set([
    'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY'
]);

const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'switch', 'slider',
    'spinbutton', 'combobox', 'listbox', 'option', 'menuitem', 'tab',
    'searchbox'
]);

const SEMANTIC_TAGS = new Set([
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'IMG', 'NAV', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE',
    'SECTION', 'ARTICLE', 'FIGURE', 'FIGCAPTION',
    'TABLE', 'FORM', 'LABEL', 'FIELDSET', 'LEGEND',
    'P', 'LI', 'OL', 'UL', 'DL', 'DT', 'DD',
]);

function isElementVisible(el: Element): boolean {
    if (!(el instanceof HTMLElement)) return true;

    // Attribute-level hiding
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.hidden) return false;

    const style = window.getComputedStyle(el);

    // Standard CSS hiding
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;

    // Overflow hidden with tiny dimensions (common sr-only pattern)
    if (style.overflow === 'hidden' && (rect.width <= 1 || rect.height <= 1)) return false;

    // clip: rect(0,0,0,0) or similar zero-area clip
    const clip = style.getPropertyValue('clip');
    if (clip && clip !== 'auto') {
        const m = clip.match(/rect\(\s*([^\s,]+)[\s,]+([^\s,]+)[\s,]+([^\s,]+)[\s,]+([^\s,]+)\s*\)/);
        if (m) {
            const [, top, right, bottom, left] = m.map(v => parseFloat(v) || 0);
            if (top === bottom && left === right) return false;
        }
    }

    // clip-path: inset(50%) or higher — hides the element
    const clipPath = style.getPropertyValue('clip-path');
    if (clipPath) {
        const insetMatch = clipPath.match(/inset\(\s*([\d.]+)(%|px)?\s*\)/);
        if (insetMatch) {
            const val = parseFloat(insetMatch[1]);
            const unit = insetMatch[2] || '%';
            if ((unit === '%' && val >= 50) || (unit === 'px' && val >= Math.min(rect.width, rect.height) / 2)) return false;
        }
    }

    // Off-screen positioning (common sr-only: position:absolute; left:-9999px)
    const position = style.position;
    if (position === 'absolute' || position === 'fixed') {
        const left = parseFloat(style.left);
        const top = parseFloat(style.top);
        if ((!isNaN(left) && left <= -9000) || (!isNaN(top) && top <= -9000)) return false;
    }

    return true;
}

function isInteractive(el: Element): boolean {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    if (el.getAttribute('tabindex') !== null && el.getAttribute('tabindex') !== '-1') return true;
    if (el.getAttribute('onclick') || el.getAttribute('ng-click') || el.getAttribute('@click')) return true;
    // Detect elements with programmatic event listeners (React/Vue/Svelte)
    if (_elementsWithListeners.has(el)) return true;
    // Also check the vanilla JS backup patch (injected via on_page_load before this module loads)
    if ((window as any).__TAURI_MCP_ELEMENTS_WITH_LISTENERS__?.has(el)) return true;
    return false;
}

function isSemanticElement(el: Element): boolean {
    if (SEMANTIC_TAGS.has(el.tagName)) return true;
    if (el.getAttribute('role')) return true;
    if (el.getAttribute('aria-label')) return true;
    if (el.getAttribute('data-testid') || el.id) return true;
    return false;
}

// --- Hierarchy / context tracking ---

const CONTEXT_TAGS = new Set([
    'NAV', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'SECTION', 'ARTICLE',
    'FORM', 'DIALOG', 'DETAILS', 'FIELDSET', 'FIGURE', 'TABLE'
]);

const LANDMARK_ROLES: Record<string, string> = {
    navigation: 'nav', main: 'main', banner: 'header', contentinfo: 'footer',
    complementary: 'aside', search: 'search', form: 'form', region: 'region', dialog: 'dialog'
};

function isContextElement(el: Element): boolean {
    if (CONTEXT_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    return !!(role && LANDMARK_ROLES[role]);
}

function buildContextLabel(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    let label = role && LANDMARK_ROLES[role] ? `[role=${role}]` : tag;
    if (el.id) label += `#${el.id}`;
    else {
        const cls = el.className;
        if (typeof cls === 'string' && cls.trim()) {
            label += `.${cls.trim().split(/\s+/)[0]}`;
        }
    }
    return label;
}

function getElementText(el: Element): string {
    // For inputs, return value or placeholder
    if (el instanceof HTMLInputElement) {
        return el.value || el.placeholder || '';
    }
    if (el instanceof HTMLTextAreaElement) {
        return el.value || el.placeholder || '';
    }
    // For selects, return selected option text
    if (el instanceof HTMLSelectElement) {
        return el.options[el.selectedIndex]?.text || '';
    }
    // For other elements, use innerText (respects visibility, includes nested text)
    let text = '';
    if (el instanceof HTMLElement) {
        text = (el.innerText || '').trim();
    }
    // If no visible text, fall back to aria-label or title
    if (!text) {
        text = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    }
    // Truncate long text
    if (text.length > 100) {
        text = text.substring(0, 97) + '...';
    }
    return text;
}

// Compute a stable fingerprint for an element to identify it across delta calls
function elementFingerprint(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const id = el.id || '';
    const name = (el as HTMLInputElement).name || '';
    const type = (el as HTMLInputElement).type || '';
    const href = (el as HTMLAnchorElement).href || '';
    const text50 = (el.textContent || '').trim().substring(0, 50);
    const class50 = (typeof el.className === 'string' ? el.className : '').substring(0, 50);
    // Sibling index for positional disambiguation
    let nthChild = 0;
    if (el.parentElement) {
        const siblings = el.parentElement.children;
        for (let i = 0; i < siblings.length; i++) {
            if (siblings[i] === el) { nthChild = i; break; }
        }
    }
    return `${tag}|${id}|${name}|${type}|${href}|${text50}|${class50}|${nthChild}`;
}

// Build a PageMapElement from a DOM element, or return null if it doesn't qualify
function buildPageMapEntry(el: Element, interactiveOnly: boolean): PageMapElement | null {
    const interactive = isInteractive(el);
    if (!interactive && (interactiveOnly || !isSemanticElement(el))) return null;

    const entry: PageMapElement = {
        ref: 0,
        tag: el.tagName.toLowerCase(),
    };

    // Mark non-interactive elements explicitly
    if (!interactive) entry.interactive = false;

    // Type for inputs
    if (el instanceof HTMLInputElement) {
        entry.type = el.type;
        if (el.value) entry.value = el.value.substring(0, 100);
        if (el.placeholder) entry.placeholder = el.placeholder;
        if (el.name) entry.name = el.name;
        if (el.type === 'checkbox' || el.type === 'radio') {
            entry.checked = el.checked;
        }
        if (el.disabled) entry.disabled = true;
    } else if (el instanceof HTMLTextAreaElement) {
        entry.type = 'textarea';
        if (el.value) entry.value = el.value.substring(0, 100);
        if (el.placeholder) entry.placeholder = el.placeholder;
        if (el.name) entry.name = el.name;
        if (el.disabled) entry.disabled = true;
    } else if (el instanceof HTMLSelectElement) {
        entry.type = 'select';
        entry.options = Array.from(el.options).map(o => o.text).slice(0, 10);
        if (el.name) entry.name = el.name;
        if (el.disabled) entry.disabled = true;
    } else if (el instanceof HTMLAnchorElement) {
        entry.href = el.href;
    } else if (el instanceof HTMLImageElement) {
        if (el.alt) entry.text = el.alt;
    }

    const text = getElementText(el);
    if (text) entry.text = text;

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel !== text) entry.ariaLabel = ariaLabel;

    const role = el.getAttribute('role');
    if (role) {
        entry.role = role;
        // ARIA widget state: without this an agent can't tell which
        // radio/tab/switch in a group is active.
        if (role === 'radio' || role === 'checkbox' || role === 'switch') {
            const checked = el.getAttribute('aria-checked');
            if (checked !== null) entry.checked = checked === 'true';
        } else if (role === 'tab' || role === 'option') {
            const selected = el.getAttribute('aria-selected');
            if (selected !== null) entry.checked = selected === 'true';
        }
    }
    if (entry.checked === undefined) {
        const pressed = el.getAttribute('aria-pressed');
        if (pressed !== null) entry.checked = pressed === 'true';
    }

    if (el.id) entry.id = el.id;

    return entry;
}

// --- Structured metadata extraction ---

function extractPageMetadata(): PageMetadata {
    const metadata: PageMetadata = {};

    // <meta name="description">
    const descMeta = document.querySelector('meta[name="description"]');
    if (descMeta) {
        const content = descMeta.getAttribute('content');
        if (content) metadata.description = content;
    }

    // OpenGraph meta tags: <meta property="og:*">
    const ogTags = document.querySelectorAll('meta[property^="og:"]');
    if (ogTags.length > 0) {
        const og: Record<string, string> = {};
        ogTags.forEach(tag => {
            const prop = tag.getAttribute('property');
            const content = tag.getAttribute('content');
            if (prop && content) og[prop] = content;
        });
        if (Object.keys(og).length > 0) metadata.openGraph = og;
    }

    // JSON-LD: <script type="application/ld+json">
    const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
    if (jsonLdScripts.length > 0) {
        const jsonLd: any[] = [];
        jsonLdScripts.forEach(script => {
            try {
                const parsed = JSON.parse(script.textContent || '');
                jsonLd.push(parsed);
            } catch {
                // Skip malformed JSON-LD
            }
        });
        if (jsonLd.length > 0) metadata.jsonLd = jsonLd;
    }

    return metadata;
}

function getPageMap(options?: PageMapOptions): PageMapResult {
    const interactiveOnly = options?.interactiveOnly === true;
    const includeContent = interactiveOnly ? false : (options?.includeContent !== false);
    const includeMetadata = options?.includeMetadata !== false;
    const maxDepth = typeof options?.maxDepth === 'number' ? options.maxDepth : Infinity;
    const isDelta = options?.delta === true;
    const scopeSelector = options?.scopeSelector;

    // Clear previous ref map
    _pageMapRefElements.clear();

    const elements: PageMapElement[] = [];
    // In delta mode, start refs above the previous max so new elements get high refs
    let refCounter = isDelta ? _previousPageMapMaxRef + 1 : 1;
    const seenTexts = new Set<string>();

    // Content priority buckets: main content first, secondary (nav/header/footer) fills remaining budget
    const SECONDARY_CONTEXT_TAGS = new Set(['NAV', 'FOOTER', 'ASIDE', 'HEADER']);
    const mainContentParts: string[] = [];
    const secondaryContentParts: string[] = [];

    // Track fingerprints for this call (used by delta mode)
    const currentFingerprints: Map<string, { ref: number; props: PageMapElement }> = new Map();

    function assignRef(el: Element, entry: PageMapElement): number {
        if (isDelta) {
            const fp = elementFingerprint(el);
            const prev = _previousPageMapFingerprints.get(fp);
            if (prev) {
                // Reuse the old ref for this fingerprint
                entry.ref = prev.ref;
                _pageMapRefElements.set(prev.ref, el);
                currentFingerprints.set(fp, { ref: prev.ref, props: entry });
                return prev.ref;
            }
        }
        // New element (or non-delta mode): assign next ref
        const ref = refCounter++;
        entry.ref = ref;
        _pageMapRefElements.set(ref, el);
        if (isDelta) {
            currentFingerprints.set(elementFingerprint(el), { ref, props: entry });
        }
        return ref;
    }

    // Determine content bucket based on context stack
    function isSecondaryContext(contextStack: string[]): boolean {
        for (const ctx of contextStack) {
            // Check if any context tag in the stack is a secondary region
            for (const tag of SECONDARY_CONTEXT_TAGS) {
                if (ctx.toLowerCase().startsWith(tag.toLowerCase()) || ctx.startsWith(`[role=${tag.toLowerCase()}`)) return true;
            }
        }
        return false;
    }

    // Track walk stats for diagnostics
    let nodesVisited = 0;

    function walkNode(node: Node, depth: number, contextStack: string[], parentRefNum: number | null, hiddenAncestor: boolean = false) {
        nodesVisited++;
        // Depth guard: stop recursing deeper than maxDepth
        if (depth > maxDepth) return;

        if (node.nodeType === Node.TEXT_NODE) {
            // In interactive-only mode, skip all text collection
            if (interactiveOnly) return;
            // Skip text inside hidden subtrees — don't pollute aggregated content
            if (hiddenAncestor) return;
            const text = (node.textContent || '').trim();
            if (includeContent && text && !seenTexts.has(text)) {
                seenTexts.add(text);
                // Route to priority bucket
                if (isSecondaryContext(contextStack)) {
                    secondaryContentParts.push(text);
                } else {
                    mainContentParts.push(text);
                }
            }
            return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node as Element;

        // Skip noise tags
        if (NOISE_TAGS.has(el.tagName)) return;

        // Skip SVG internals (keep the top-level <svg> but skip its children)
        // Normalize tagName for SVG namespace (can be mixed case)
        const tagUpper = el.tagName.toUpperCase();
        const isSvgNamespace = el.namespaceURI === 'http://www.w3.org/2000/svg';
        if (tagUpper === 'SVG' || (isSvgNamespace && tagUpper !== 'SVG')) {
            if (tagUpper === 'SVG') {
                const label = el.getAttribute('aria-label');
                if (label && isElementVisible(el)) {
                    const entry: PageMapElement = {
                        ref: 0,
                        tag: 'svg',
                        ariaLabel: label,
                        depth,
                    };
                    if (contextStack.length > 0) entry.context = contextStack.join(' > ');
                    if (parentRefNum !== null) entry.parentRef = parentRefNum;
                    assignRef(el, entry);
                    elements.push(entry);
                }
            }
            return;
        }

        // Update context stack if this is a context element
        let newContextStack = contextStack;
        if (isContextElement(el)) {
            newContextStack = [...contextStack, buildContextLabel(el)];
        }

        // Check element visibility — propagate hidden state to descendants
        const selfVisible = isElementVisible(el);
        const isHidden = hiddenAncestor || !selfVisible;

        let currentParentRef = parentRefNum;
        if (selfVisible && !hiddenAncestor) {
            // Fully visible element — emit normally
            const entry = buildPageMapEntry(el, interactiveOnly);
            if (entry) {
                entry.depth = depth;
                if (newContextStack.length > 0) entry.context = newContextStack.join(' > ');
                if (parentRefNum !== null) entry.parentRef = parentRefNum;

                assignRef(el, entry);
                elements.push(entry);
                currentParentRef = entry.ref;
            }
        } else {
            // Hidden element or inside hidden ancestor — still emit but flag as not visible
            const entry = buildPageMapEntry(el, interactiveOnly);
            if (entry) {
                entry.depth = depth;
                entry.visible = false;
                if (newContextStack.length > 0) entry.context = newContextStack.join(' > ');
                if (parentRefNum !== null) entry.parentRef = parentRefNum;

                assignRef(el, entry);
                elements.push(entry);
                currentParentRef = entry.ref;
            }
        }

        // Always walk children (even of hidden wrappers) so we don't miss content
        for (const child of el.childNodes) {
            walkNode(child, depth + 1, newContextStack, currentParentRef, isHidden);
        }
    }

    // Scope-aware root selection
    const roots: Element[] = [];
    if (scopeSelector) {
        const selectors = Array.isArray(scopeSelector) ? scopeSelector : [scopeSelector];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) roots.push(el);
        }
    }
    if (roots.length === 0) {
        roots.push(document.body || document.documentElement);
    }
    for (const root of roots) {
        walkNode(root, 0, [], null);
    }

    // Fallback: if recursive walk found nothing, try a flat querySelectorAll scan
    if (elements.length === 0 && nodesVisited < 5) {
        console.warn(`TAURI-PLUGIN-MCP: Recursive walk visited only ${nodesVisited} nodes. Trying flat scan fallback.`);
        const allEls = document.querySelectorAll('body *');
        for (const el of allEls) {
            if (NOISE_TAGS.has(el.tagName)) continue;
            if (el.namespaceURI === 'http://www.w3.org/2000/svg') continue;
            if (!isElementVisible(el)) continue;

            const entry = buildPageMapEntry(el, interactiveOnly);
            if (entry) {
                // Compute context by walking ancestors
                const ctxParts: string[] = [];
                let ancestor: Element | null = el.parentElement;
                while (ancestor && ancestor !== document.body) {
                    if (isContextElement(ancestor)) {
                        ctxParts.unshift(buildContextLabel(ancestor));
                    }
                    ancestor = ancestor.parentElement;
                }
                if (ctxParts.length > 0) entry.context = ctxParts.join(' > ');

                assignRef(el, entry);
                elements.push(entry);
            }

            // Collect text content
            if (!interactiveOnly && includeContent) {
                for (const child of el.childNodes) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        const text = (child.textContent || '').trim();
                        if (text && !seenTexts.has(text)) {
                            seenTexts.add(text);
                            mainContentParts.push(text);
                        }
                    }
                }
            }
        }
    }

    // Delta metadata
    let deltaResult: PageMapDelta | undefined;
    if (isDelta) {
        const added: number[] = [];
        const removed: number[] = [];
        const changed: number[] = [];

        // Find added & changed
        for (const [fp, cur] of currentFingerprints) {
            const prev = _previousPageMapFingerprints.get(fp);
            if (!prev) {
                added.push(cur.ref);
            } else {
                // Compare props (excluding ref) to detect changes
                const curClone = { ...cur.props, ref: 0 };
                const prevClone = { ...prev.props, ref: 0 };
                if (JSON.stringify(curClone) !== JSON.stringify(prevClone)) {
                    changed.push(cur.ref);
                }
            }
        }

        // Find removed (fingerprints in previous but not current)
        for (const [fp, prev] of _previousPageMapFingerprints) {
            if (!currentFingerprints.has(fp)) {
                removed.push(prev.ref);
            }
        }

        deltaResult = { added, removed, changed };

        // Store current state for next delta call
        _previousPageMapFingerprints = currentFingerprints;
        _previousPageMapMaxRef = Math.max(refCounter - 1, ...elements.map(e => e.ref));
    } else {
        // Non-delta call: reset tracking state (clean slate)
        _previousPageMapFingerprints = new Map();
        _previousPageMapMaxRef = 0;
    }

    // Build compressed content string with priority buckets
    let content = '';
    if (includeContent) {
        const mainText = mainContentParts.join(' ').replace(/\s+/g, ' ').trim();
        const secondaryText = secondaryContentParts.join(' ').replace(/\s+/g, ' ').trim();
        const CONTENT_BUDGET = 5000;

        if (mainText.length >= CONTENT_BUDGET) {
            content = mainText.substring(0, CONTENT_BUDGET - 3) + '...';
        } else {
            content = mainText;
            const remaining = CONTENT_BUDGET - content.length;
            if (remaining > 10 && secondaryText) {
                const sep = content ? ' ' : '';
                if (secondaryText.length <= remaining - sep.length) {
                    content += sep + secondaryText;
                } else {
                    content += sep + secondaryText.substring(0, remaining - sep.length - 3) + '...';
                }
            }
        }
    }

    const result: PageMapResult = {
        url: window.location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        elements,
        content,
    };

    // Add structured page metadata
    if (includeMetadata) {
        const metadata = extractPageMetadata();
        if (metadata.description || metadata.openGraph || metadata.jsonLd) {
            result.metadata = metadata;
        }
    }

    // Add optional metadata
    if (scopeSelector) result.scope = scopeSelector;
    if (typeof options?.maxDepth === 'number') result.maxDepth = options.maxDepth;
    if (deltaResult) result.delta = deltaResult;

    const interactiveCount = elements.filter(e => e.interactive !== false).length;
    console.log(`TAURI-PLUGIN-MCP: Page map generated: ${elements.length} total elements (${interactiveCount} interactive), ${content.length} chars content, ${nodesVisited} nodes visited`);
    return result;
}

// Export the ref map lookup for use by other handlers
function getElementByRef(ref: number): Element | null {
    return _pageMapRefElements.get(ref) || null;
}

async function handleLocalStorageRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received get-local-storage, payload:', event.payload);
    const correlationId = getCorrelationId(event.payload);

    try {
        const { action, key, value } = event.payload;
        
        // Convert values that might be JSON strings to their actual values
        let processedKey = key;
        let processedValue = value;
        
        // If key is a JSON string, try to parse it
        if (typeof key === 'string') {
            try {
                if (key.trim().startsWith('{') || key.trim().startsWith('[')) {
                    processedKey = JSON.parse(key);
                }
            } catch (e) {
                // Keep original if parsing fails
                console.log('TAURI-PLUGIN-MCP: Key not valid JSON, using as string');
            }
        }
        
        // If value is a JSON string, try to parse it
        if (typeof value === 'string') {
            try {
                if (value.trim().startsWith('{') || value.trim().startsWith('[')) {
                    processedValue = JSON.parse(value);
                }
            } catch (e) {
                // Keep original if parsing fails
                console.log('TAURI-PLUGIN-MCP: Value not valid JSON, using as string');
            }
        }
        
        console.log('TAURI-PLUGIN-MCP: Processing localStorage operation', { 
            action, 
            processedKey, 
            processedValue 
        });
        
        const result = performLocalStorageOperation(action, processedKey, processedValue);
        await emitResponse('get-local-storage-response', correlationId, result);
        console.log('TAURI-PLUGIN-MCP: Emitted get-local-storage-response');
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling localStorage request', error);
        await emitResponse('get-local-storage-response', correlationId, {
            success: false,
            error: error instanceof Error ? error.toString() : String(error)
        }).catch(e =>
            console.error('TAURI-PLUGIN-MCP: Error emitting error response', e)
        );
    }
}

function performLocalStorageOperation(action: string, key?: string | any, value?: string | any): any {
    console.log('TAURI-PLUGIN-MCP: LocalStorage operation', { 
        action, 
        key: typeof key === 'undefined' ? 'undefined' : key, 
        value: typeof value === 'undefined' ? 'undefined' : value,
        keyType: typeof key,
        valueType: typeof value 
    });
    
    switch(action) {
        case 'get':
            if (!key) {
                console.log('TAURI-PLUGIN-MCP: Getting all localStorage items');
                // If no key is provided, return all localStorage items
                const allItems: Record<string, string> = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k) {
                        allItems[k] = localStorage.getItem(k) || '';
                    }
                }
                return {
                    success: true,
                    data: allItems
                };
            }
            console.log(`TAURI-PLUGIN-MCP: Getting localStorage item with key: ${key}`);
            return {
                success: true,
                data: localStorage.getItem(String(key))
            };
        case 'set':
            if (!key) {
                console.log('TAURI-PLUGIN-MCP: Set operation failed - no key provided');
                throw new Error('Key is required for set operation');
            }
            if (value === undefined) {
                console.log('TAURI-PLUGIN-MCP: Set operation failed - no value provided');
                throw new Error('Value is required for set operation');
            }
            
            const keyStr = String(key);
            const valueStr = String(value);
            console.log(`TAURI-PLUGIN-MCP: Setting localStorage item: ${keyStr} = ${valueStr}`);
            
            localStorage.setItem(keyStr, valueStr);
            return { success: true };
        case 'remove':
            if (!key) {
                console.log('TAURI-PLUGIN-MCP: Remove operation failed - no key provided');
                throw new Error('Key is required for remove operation');
            }
            console.log(`TAURI-PLUGIN-MCP: Removing localStorage item with key: ${key}`);
            localStorage.removeItem(String(key));
            return { success: true };
        case 'clear':
            console.log('TAURI-PLUGIN-MCP: Clearing all localStorage items');
            localStorage.clear();
            return { success: true };
        case 'keys':
            console.log('TAURI-PLUGIN-MCP: Getting all localStorage keys');
            return {
                success: true,
                data: Object.keys(localStorage)
            };
        default:
            console.log(`TAURI-PLUGIN-MCP: Unsupported localStorage action: ${action}`);
            throw new Error(`Unsupported localStorage action: ${action}`);
    }
}

// Handle JS execution requests
async function handleJsExecutionRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received execute-js, payload:', event.payload);
    const correlationId = getCorrelationId(event.payload);

    try {
        // Extract the code to execute — may be wrapped in _payload by emit_and_wait
        const code = (typeof event.payload === 'object' && event.payload._payload !== undefined)
            ? event.payload._payload
            : event.payload;

        // Execute the code
        const result = executeJavaScript(code);

        // Prepare response with result and type information
        const response = {
            result: typeof result === 'object' ? JSON.stringify(result) : String(result),
            type: typeof result
        };

        // Send back the result
        await emitResponse('execute-js-response', correlationId, response);
        console.log('TAURI-PLUGIN-MCP: Emitted execute-js-response');
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error executing JavaScript:', error);
        const errorMessage = error instanceof Error ? error.toString() : String(error);

        await emitResponse('execute-js-response', correlationId, {
            result: null,
            type: 'error',
            error: errorMessage
        }).catch(e =>
            console.error('TAURI-PLUGIN-MCP: Error emitting error response', e)
        );
    }
}

// Function to safely execute JavaScript code
function executeJavaScript(code: string): any {
    // Using Function constructor is slightly safer than eval
    // It runs in global scope rather than local scope
    try {
        // For expressions, return the result
        return new Function(`return (${code})`)();
    } catch {
        // If that fails, try executing as statements
        return new Function(code)();
    }
}

async function handleSendTextToElementRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received send-text-to-element, payload:', event.payload);
    const correlationId = getCorrelationId(event.payload);

    // Dedup guard: skip if this correlation ID was already handled
    if (correlationId && _handledCorrelationIds.has(correlationId)) {
        console.warn('TAURI-PLUGIN-MCP: Ignoring duplicate send-text-to-element for correlation ID:', correlationId);
        return;
    }
    if (correlationId) {
        _handledCorrelationIds.add(correlationId);
        setTimeout(() => _handledCorrelationIds.delete(correlationId), 30000);
    }

    try {
        const { selectorType, selectorValue, text, delayMs = 20 } = event.payload;

        // Find the element based on the selector type
        let element = null;
        let debugInfo = [];

        switch (selectorType) {
            case 'ref':
                // Look up by numbered reference from get_page_map
                const refNum = parseInt(selectorValue, 10);
                element = getElementByRef(refNum);
                if (!element) {
                    debugInfo.push(`No element found with ref=${refNum}. Call get_page_map first to populate refs.`);
                }
                break;
            case 'id':
                element = document.getElementById(selectorValue);
                if (!element) {
                    debugInfo.push(`No element found with id="${selectorValue}"`);
                }
                break;
            case 'class':
                // Get the first element with the class
                const elemsByClass = document.getElementsByClassName(selectorValue);
                element = elemsByClass.length > 0 ? elemsByClass[0] : null;
                if (!element) {
                    debugInfo.push(`No elements found with class="${selectorValue}" (total matching: 0)`);
                } else if (elemsByClass.length > 1) {
                    debugInfo.push(`Found ${elemsByClass.length} elements with class="${selectorValue}", using the first one`);
                }
                break;
            case 'tag':
                // Get the first element with the tag name
                const elemsByTag = document.getElementsByTagName(selectorValue);
                element = elemsByTag.length > 0 ? elemsByTag[0] : null;
                if (!element) {
                    debugInfo.push(`No elements found with tag="${selectorValue}" (total matching: 0)`);
                } else if (elemsByTag.length > 1) {
                    debugInfo.push(`Found ${elemsByTag.length} elements with tag="${selectorValue}", using the first one`);
                }
                break;
            case 'css':
                // Any CSS selector — first match
                element = document.querySelector(selectorValue);
                if (!element) {
                    debugInfo.push(`No element found matching CSS selector "${selectorValue}"`);
                }
                break;
            case 'text':
                // Find element by text content
                element = findElementByText(selectorValue);
                if (!element) {
                    debugInfo.push(`No element found with text="${selectorValue}"`);
                }
                break;
            default:
                throw new Error(`Unsupported selector type: ${selectorType}`);
        }
        
        if (!element) {
            throw new Error(`Element with ${selectorType}="${selectorValue}" not found. ${debugInfo.join(' ')}`);
        }
        
        // <select> elements: pick the matching option instead of typing
        if (element instanceof HTMLSelectElement) {
            if (!selectOptionOnSelect(element, text)) {
                throw selectOptionError(element, text);
            }
            await emitResponse('send-text-to-element-response', correlationId, {
                success: true,
                data: {
                    element: {
                        tag: element.tagName,
                        classes: element.className,
                        id: element.id,
                        type: 'select',
                        text: text,
                        isEditable: true,
                        strategy: 'select'
                    }
                }
            });
            return;
        }

        // Check if the element is an input field, textarea, or has contentEditable
        const isEditableElement =
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element.isContentEditable;
            
        if (!isEditableElement) {
            console.warn(`Element is not normally editable: ${element.tagName}. Will try to set value/textContent directly.`);
        }
        
        // Focus the element first
        element.focus();
        
        // Set the text content based on element type
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            await simulateReactInputTyping(element, text, delayMs);
        } else if (element.isContentEditable) {
            // For contentEditable elements 
            console.log(`TAURI-PLUGIN-MCP: Setting text in contentEditable element: ${element.id || element.className}`);
            
            // Check if it's a specific type of editor
            const isLexicalEditor = element.hasAttribute('data-lexical-editor');
            const isSlateEditor = element.hasAttribute('data-slate-editor') || element.querySelector('[data-slate-editor="true"]') !== null;
            
            if (isLexicalEditor) {
                console.log('TAURI-PLUGIN-MCP: Detected Lexical editor, using specialized handling');
                await typeIntoLexicalEditor(element, text, delayMs);
            } else if (isSlateEditor) {
                console.log('TAURI-PLUGIN-MCP: Detected Slate editor, using specialized handling');
                await typeIntoSlateEditor(element, text, delayMs);
            } else {
                // Generic contentEditable handling
                await typeIntoContentEditable(element, text, delayMs);
            }
        } else {
            // For other elements, try to set textContent (may not work as expected)
            element.textContent = text;
            console.warn('TAURI-PLUGIN-MCP: Element is not an input, textarea, or contentEditable. Text was set directly but may not behave as expected.');
        }
        
        await emitResponse('send-text-to-element-response', correlationId, {
            success: true,
            data: {
                element: {
                    tag: element.tagName,
                    classes: element.className,
                    id: element.id,
                    type: element instanceof HTMLInputElement ? element.type : null,
                    text: text,
                    isEditable: isEditableElement
                }
            }
        });
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling send-text-to-element request', error);
        await emitResponse('send-text-to-element-response', correlationId, {
            success: false,
            error: error instanceof Error ? error.toString() : String(error)
        }).catch(e => console.error('TAURI-PLUGIN-MCP: Error emitting error response', e));
    }
}

// Select the <option> of a <select> whose value or visible text matches (case-insensitive).
// Dispatches input + change so React/Vue controlled selects pick up the new value.
function selectOptionOnSelect(el: HTMLSelectElement, value: string): boolean {
    const needle = value.toLowerCase().trim();
    for (const opt of el.options) {
        if (opt.value.toLowerCase().trim() === needle || opt.text.toLowerCase().trim() === needle) {
            el.focus();
            opt.selected = true;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
    }
    return false;
}

function selectOptionError(el: HTMLSelectElement, value: string): Error {
    const available = Array.from(el.options).map(o => o.text || o.value).slice(0, 20);
    return new Error(`No <option> matching "${value}" found in <select>${el.id ? ' #' + el.id : ''}. Available options: ${JSON.stringify(available)}`);
}

// Simulate typing into React controlled input/textarea elements.
// Uses document.execCommand('insertText') which triggers the browser's native
// input handling pipeline — React sees a genuine InputEvent and updates its
// internal value tracker correctly. Direct element.value assignment + synthetic
// Event('input') does NOT work because React's fiber state never registers the change.
async function simulateReactInputTyping(element: HTMLInputElement | HTMLTextAreaElement, text: string, delayMs: number, clear: boolean = true): Promise<void> {
    console.log('TAURI-PLUGIN-MCP: Simulating typing on React component via execCommand');

    // Focus the element — required for execCommand to target it
    element.focus();
    await new Promise(resolve => setTimeout(resolve, 50));

    try {
        // Clear existing content only when requested (default for selector mode,
        // skipped for focused mode so typing appends at the cursor)
        if (clear) {
            element.select();
            document.execCommand('delete', false);
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        if (delayMs > 0) {
            // Character-by-character typing with delays
            // Only use execCommand('insertText') — synthetic KeyboardEvents can cause
            // duplicate character insertion in some frameworks that handle keydown events
            for (let i = 0; i < text.length; i++) {
                document.execCommand('insertText', false, text[i]);

                if (i < text.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        } else {
            // Insert all text at once for speed
            document.execCommand('insertText', false, text);
        }

        console.log('TAURI-PLUGIN-MCP: Completed React input typing simulation');
    } catch (e) {
        console.error('TAURI-PLUGIN-MCP: execCommand approach failed, trying nativeInputValueSetter fallback:', e);

        // Fallback: use the native value setter to bypass React's proxy,
        // then dispatch an InputEvent (not just Event) with inputType set
        const proto = element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

        if (nativeSetter) {
            nativeSetter.call(element, text);
        } else {
            element.value = text;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

// Helper function to type text into a contentEditable element with a delay
async function typeIntoContentEditable(element: HTMLElement, text: string, delayMs: number): Promise<void> {
    console.log('TAURI-PLUGIN-MCP: Using general contentEditable typing approach');
    
    try {
        // Focus first
        element.focus();
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Clear existing content
        element.innerHTML = '';
        // Dispatch input event to notify frameworks of the change
        element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // For regular contentEditable, character-by-character simulation works well
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            
            // Simulate keydown
            const keydownEvent = new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                key: char,
                code: `Key${char.toUpperCase()}`
            });
            element.dispatchEvent(keydownEvent);
            
            // Insert the character by simulating typing
            // Use DOM selection and insertNode for proper insertion at cursor
            const selection = window.getSelection();
            const range = document.createRange();
            
            // Set range to end of element
            range.selectNodeContents(element);
            range.collapse(false); // Collapse to the end
            
            // Apply the selection
            selection?.removeAllRanges();
            selection?.addRange(range);
            
            // Insert text at cursor position
            const textNode = document.createTextNode(char);
            range.insertNode(textNode);
            
            // Move selection to after inserted text
            range.setStartAfter(textNode);
            range.setEndAfter(textNode);
            selection?.removeAllRanges();
            selection?.addRange(range);
            
            // Dispatch input event to notify of change
            element.dispatchEvent(new InputEvent('input', { 
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: char
            }));
            
            // Simulate keyup
            const keyupEvent = new KeyboardEvent('keyup', {
                bubbles: true,
                cancelable: true,
                key: char,
                code: `Key${char.toUpperCase()}`
            });
            element.dispatchEvent(keyupEvent);
            
            // Add delay between keypresses
            if (delayMs > 0 && i < text.length - 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        
        // Final change event
        element.dispatchEvent(new Event('change', { bubbles: true }));
        
        console.log('TAURI-PLUGIN-MCP: Completed contentEditable text entry');
    } catch (e) {
        console.error('TAURI-PLUGIN-MCP: Error in contentEditable typing:', e);
        
        // Fallback: direct setting
        element.textContent = text;
        element.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
}

// Helper function specifically for Lexical Editor
async function typeIntoLexicalEditor(element: HTMLElement, text: string, delayMs: number): Promise<void> {
    console.log('TAURI-PLUGIN-MCP: Starting specialized Lexical editor typing');
    
    try {
        // First focus the element
        element.focus();
        await new Promise(resolve => setTimeout(resolve, 100)); // Longer focus delay for Lexical
        
        // Clear the editor - find any paragraph elements and clear them
        const paragraphs = element.querySelectorAll('p');
        if (paragraphs.length > 0) {
            for (const p of paragraphs) {
                p.innerHTML = '<br>'; // Lexical often uses <br> for empty paragraphs
            }
        } else {
            // If no paragraphs, try clearing directly (less reliable)
            element.innerHTML = '<p class="editor-paragraph"><br></p>';
        }
        
        // Trigger input event to notify Lexical of the change
        element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Find the first paragraph to type into
        const targetParagraph = element.querySelector('p') || element;
        
        // For Lexical, we'll also use the beforeinput event which it may listen for
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            
            // Find active element in case Lexical changed it
            const activeElement = document.activeElement;
            const currentTarget = (activeElement && element.contains(activeElement)) 
                ? activeElement 
                : targetParagraph;
            
            // Dispatch beforeinput event (important for Lexical)
            const beforeInputEvent = new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: char
            });
            currentTarget.dispatchEvent(beforeInputEvent);
            
            // Create and dispatch keydown
            const keydownEvent = new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                key: char,
                code: `Key${char.toUpperCase()}`,
                composed: true
            });
            currentTarget.dispatchEvent(keydownEvent);
            
            // Use execCommand for more reliable text insertion
            if (!beforeInputEvent.defaultPrevented) {
                document.execCommand('insertText', false, char);
            }
            
            // Dispatch input event
            const inputEvent = new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: char
            });
            currentTarget.dispatchEvent(inputEvent);
            
            // Create and dispatch keyup
            const keyupEvent = new KeyboardEvent('keyup', {
                bubbles: true,
                cancelable: true,
                key: char,
                code: `Key${char.toUpperCase()}`,
                composed: true
            });
            currentTarget.dispatchEvent(keyupEvent);
            
            // Add delay between keypresses
            if (delayMs > 0 && i < text.length - 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        
        // Final selection adjustment (move to end of text)
        try {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(targetParagraph);
            range.collapse(false); // Collapse to end
            selection?.removeAllRanges();
            selection?.addRange(range);
        } catch (e) {
            console.warn('TAURI-PLUGIN-MCP: Error setting final selection:', e);
        }
        
        console.log('TAURI-PLUGIN-MCP: Completed Lexical editor typing');
    } catch (e) {
        console.error('TAURI-PLUGIN-MCP: Error in Lexical editor typing:', e);
        
        // Last resort fallback - try to set content directly
        try {
            const firstParagraph = element.querySelector('p') || element;
            firstParagraph.textContent = text;
            element.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } catch (innerError) {
            console.error('TAURI-PLUGIN-MCP: Fallback for Lexical editor failed:', innerError);
        }
    }
}

// Helper function specifically for Slate Editor
async function typeIntoSlateEditor(element: HTMLElement, text: string, delayMs: number): Promise<void> {
    console.log('TAURI-PLUGIN-MCP: Starting specialized Slate editor typing');
    
    try {
        // Focus the element
        element.focus();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Find the actual editable div in Slate editor
        const editableDiv = element.querySelector('[contenteditable="true"]') || element;
        if (editableDiv instanceof HTMLElement) {
            editableDiv.focus();
        }
        
        // For Slate, we'll try the execCommand approach which is often more reliable
        document.execCommand('selectAll', false, undefined);
        document.execCommand('delete', false, undefined);
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Simulate typing with proper events
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            
            // Ensure we're targeting the active element (Slate may change focus)
            const activeElement = document.activeElement || editableDiv;
            
            // Key events sequence
            activeElement.dispatchEvent(new KeyboardEvent('keydown', {
                key: char,
                bubbles: true,
                cancelable: true
            }));
            
            // Use execCommand for insertion
            document.execCommand('insertText', false, char);
            
            activeElement.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: char
            }));
            
            activeElement.dispatchEvent(new KeyboardEvent('keyup', {
                key: char,
                bubbles: true,
                cancelable: true
            }));
            
            // Delay between characters
            if (delayMs > 0 && i < text.length - 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        
        console.log('TAURI-PLUGIN-MCP: Completed Slate editor typing');
    } catch (e) {
        console.error('TAURI-PLUGIN-MCP: Error in Slate editor typing:', e);
        
        // Fallback approach
        try {
            const editableDiv = element.querySelector('[contenteditable="true"]') || element;
            editableDiv.textContent = text;
            editableDiv.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } catch (innerError) {
            console.error('TAURI-PLUGIN-MCP: Fallback for Slate editor failed:', innerError);
        }
    }
}

// --- get_page_state handler ---
async function handleGetPageStateRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received get-page-state');
    const correlationId = getCorrelationId(event.payload);
    try {
        await emitResponse('get-page-state-response', correlationId, JSON.stringify({
            success: true,
            data: {
                url: window.location.href,
                title: document.title,
                readyState: document.readyState,
                scrollPosition: { x: window.scrollX, y: window.scrollY },
                viewport: { width: window.innerWidth, height: window.innerHeight }
            }
        }));
    } catch (error) {
        await emitResponse('get-page-state-response', correlationId, JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        }));
    }
}

// --- navigate_back handler ---
async function handleNavigateBackRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received navigate-back, payload:', event.payload);
    const correlationId = getCorrelationId(event.payload);
    try {
        const { direction, delta } = event.payload || {};

        if (typeof delta === 'number') {
            history.go(delta);
        } else if (direction === 'forward') {
            history.forward();
        } else {
            history.back();
        }

        // Wait briefly for navigation to take effect
        await new Promise(resolve => setTimeout(resolve, 500));

        await emitResponse('navigate-back-response', correlationId, JSON.stringify({
            success: true,
            data: {
                url: window.location.href,
                title: document.title
            }
        }));
    } catch (error) {
        await emitResponse('navigate-back-response', correlationId, JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        }));
    }
}

// --- scroll_page handler ---
async function handleScrollPageRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received scroll-page, payload:', event.payload);
    const correlationId = getCorrelationId(event.payload);
    try {
        const { direction, amount, toRef, toTop, toBottom } = event.payload || {};

        if (toTop) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (toBottom) {
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
        } else if (typeof toRef === 'number') {
            const el = getElementByRef(toRef);
            if (!el) {
                throw new Error(`No element found with ref=${toRef}. Call get_page_map first.`);
            }
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            const vh = window.innerHeight;
            let pixels: number;
            if (typeof amount === 'number') {
                pixels = amount;
            } else if (amount === 'half') {
                pixels = Math.round(vh / 2);
            } else {
                // default: "page"
                pixels = vh;
            }
            if (direction === 'up') {
                pixels = -pixels;
            }
            window.scrollBy({ top: pixels, behavior: 'smooth' });
        }

        // Wait for smooth scroll to settle
        await new Promise(resolve => setTimeout(resolve, 350));

        await emitResponse('scroll-page-response', correlationId, JSON.stringify({
            success: true,
            data: {
                scrollPosition: { x: window.scrollX, y: window.scrollY },
                pageHeight: document.documentElement.scrollHeight,
                viewport: { width: window.innerWidth, height: window.innerHeight }
            }
        }));
    } catch (error) {
        await emitResponse('scroll-page-response', correlationId, JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        }));
    }
}

// --- fill_form handler ---

// Helper to resolve an element from a field entry (by ref or selector)
function resolveElement(field: { ref?: number; selectorType?: string; selectorValue?: string }): Element | null {
    if (typeof field.ref === 'number') {
        return getElementByRef(field.ref);
    }
    if (field.selectorType && field.selectorValue) {
        switch (field.selectorType) {
            case 'id': return document.getElementById(field.selectorValue);
            case 'class': return document.getElementsByClassName(field.selectorValue)[0] || null;
            case 'css': return document.querySelector(field.selectorValue);
            case 'tag': return document.getElementsByTagName(field.selectorValue)[0] || null;
            case 'text': return findElementByText(field.selectorValue);
            default: return null;
        }
    }
    return null;
}

async function handleFillFormRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received fill-form, payload:', event.payload);
    const correlationId = getCorrelationId(event.payload);

    // Dedup guard: skip if this correlation ID was already handled
    if (correlationId && _handledCorrelationIds.has(correlationId)) {
        console.warn('TAURI-PLUGIN-MCP: Ignoring duplicate fill-form for correlation ID:', correlationId);
        return;
    }
    if (correlationId) {
        _handledCorrelationIds.add(correlationId);
        setTimeout(() => _handledCorrelationIds.delete(correlationId), 30000);
    }

    try {
        const { fields, submitRef } = event.payload || {};

        if (!Array.isArray(fields) || fields.length === 0) {
            throw new Error('fields array is required and must not be empty');
        }

        const results: Array<{ ref?: number; success: boolean; error?: string }> = [];

        for (const field of fields) {
            const entry: { ref?: number; success: boolean; error?: string } = { ref: field.ref, success: false };
            try {
                const el = resolveElement(field);
                if (!el) {
                    entry.error = `Element not found (ref=${field.ref}, selector=${field.selectorType}:${field.selectorValue})`;
                    results.push(entry);
                    continue;
                }

                const clear = field.clear !== false; // default true

                if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                    el.focus();
                    // Forward the field's clear preference (default true)
                    await simulateReactInputTyping(el, field.value, 0, clear);
                } else if (el instanceof HTMLSelectElement) {
                    if (!selectOptionOnSelect(el, field.value)) {
                        throw selectOptionError(el, field.value);
                    }
                } else if (el instanceof HTMLElement && el.isContentEditable) {
                    el.focus();
                    if (clear) {
                        el.innerHTML = '';
                        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
                    }
                    await typeIntoContentEditable(el, field.value, 0);
                } else {
                    entry.error = `Element <${el.tagName}> is not a form field`;
                    results.push(entry);
                    continue;
                }

                entry.success = true;
            } catch (fieldError) {
                entry.error = fieldError instanceof Error ? fieldError.message : String(fieldError);
            }
            results.push(entry);
        }

        // Optionally click submit button
        let submitResult = null;
        if (typeof submitRef === 'number') {
            const submitEl = getElementByRef(submitRef);
            if (submitEl && submitEl instanceof HTMLElement) {
                submitEl.click();
                submitResult = { clicked: true, tag: submitEl.tagName };
            } else {
                submitResult = { clicked: false, error: `Submit element ref=${submitRef} not found` };
            }
        }

        await emitResponse('fill-form-response', correlationId, JSON.stringify({
            success: true,
            data: { fields: results, submit: submitResult }
        }));
    } catch (error) {
        await emitResponse('fill-form-response', correlationId, JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        }));
    }
}

// --- wait_for handler ---
async function handleWaitForRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received wait-for, payload:', event.payload);
    const correlationId = getCorrelationId(event.payload);
    try {
        const { text, selector, ref: refNum, state = 'visible', timeoutMs = 10000 } = event.payload || {};
        const pollInterval = 200;

        const result = await new Promise<{ found: boolean; elapsed: number }>((resolve) => {
            const startTime = Date.now();
            let observer: MutationObserver | null = null;

            function checkCondition(): boolean {
                if (typeof text === 'string') {
                    const bodyText = document.body?.innerText || '';
                    const found = bodyText.includes(text);
                    return state === 'hidden' ? !found : found;
                }

                let el: Element | null = null;
                if (typeof refNum === 'number') {
                    el = getElementByRef(refNum);
                } else if (typeof selector === 'string') {
                    el = document.querySelector(selector);
                }

                switch (state) {
                    case 'attached':
                        return el !== null;
                    case 'detached':
                        return el === null;
                    case 'hidden':
                        if (!el) return true;
                        return !isElementVisible(el);
                    case 'visible':
                    default:
                        if (!el) return false;
                        return isElementVisible(el);
                }
            }

            function finish(found: boolean) {
                if (observer) observer.disconnect();
                resolve({ found, elapsed: Date.now() - startTime });
            }

            // Check immediately
            if (checkCondition()) {
                finish(true);
                return;
            }

            // Set up polling + MutationObserver
            const interval = setInterval(() => {
                if (checkCondition()) {
                    clearInterval(interval);
                    finish(true);
                    return;
                }
                if (Date.now() - startTime >= timeoutMs) {
                    clearInterval(interval);
                    finish(false);
                }
            }, pollInterval);

            observer = new MutationObserver(() => {
                if (checkCondition()) {
                    clearInterval(interval);
                    finish(true);
                }
            });

            observer.observe(document.body || document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
            });

            // Hard timeout
            setTimeout(() => {
                clearInterval(interval);
                finish(checkCondition());
            }, timeoutMs);
        });

        await emitResponse('wait-for-response', correlationId, JSON.stringify({
            success: true,
            data: {
                found: result.found,
                elapsed: result.elapsed,
                timedOut: !result.found
            }
        }));
    } catch (error) {
        await emitResponse('wait-for-response', correlationId, JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        }));
    }
}

// --- type_into_focused handler ---
// Types text into the currently focused element using JS-based strategies.
// Detects Lexical, Slate, contentEditable, and standard inputs/textareas.
async function handleTypeIntoFocusedRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received type-into-focused, payload:', event.payload);
    const correlationId = getCorrelationId(event.payload);

    // Dedup guard: skip if this correlation ID was already handled
    if (correlationId && _handledCorrelationIds.has(correlationId)) {
        console.warn('TAURI-PLUGIN-MCP: Ignoring duplicate type-into-focused for correlation ID:', correlationId);
        return;
    }
    if (correlationId) {
        _handledCorrelationIds.add(correlationId);
        setTimeout(() => _handledCorrelationIds.delete(correlationId), 30000);
    }

    try {
        const { text, delayMs = 20, initialDelayMs } = event.payload || {};

        if (!text) {
            throw new Error('text parameter is required');
        }

        // Optional initial delay to let UI focus transitions settle
        if (typeof initialDelayMs === 'number' && initialDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, initialDelayMs));
        }

        let el = document.activeElement;
        // Fall back to last focused element if active element is not typeable
        // (focus may have shifted to a button, toolbar, or body between tool calls)
        if (!el || el === document.body || el === document.documentElement || !isTypeable(el)) {
            el = _lastFocusedElement;
        }
        // Third fallback: recover from stored click coordinates
        if (!el || el === document.body || el === document.documentElement || !isTypeable(el)) {
            const coords = (window as any).__mcpLastClickCoords;
            if (coords && typeof coords.x === 'number' && typeof coords.y === 'number') {
                let pointEl: Element | null = document.elementFromPoint(coords.x, coords.y);
                while (pointEl && pointEl !== document.body) {
                    if (isTypeable(pointEl)) break;
                    pointEl = pointEl.parentElement;
                }
                if (pointEl && pointEl !== document.body && isTypeable(pointEl)) {
                    el = pointEl;
                    if (el instanceof HTMLElement) el.focus({ preventScroll: true });
                    _lastFocusedElement = el;
                }
            }
        }
        if (!el || el === document.body || el === document.documentElement) {
            throw new Error('No element is currently focused. Click an element first or use selector mode.');
        }
        // Re-focus the element to ensure it can receive input
        if (el instanceof HTMLElement) {
            el.focus();
        }

        const elementInfo: Record<string, string> = {
            tag: el.tagName.toLowerCase(),
        };
        if (el.id) elementInfo.id = el.id;
        if (el instanceof HTMLElement && el.className) elementInfo.className = el.className.toString().substring(0, 100);

        // Route to the appropriate typing strategy
        if (el instanceof HTMLSelectElement) {
            elementInfo.strategy = 'select';
            if (!selectOptionOnSelect(el, text)) {
                throw selectOptionError(el, text);
            }
        } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            elementInfo.strategy = 'react-input';
            // In focused mode, don't clear — append at the cursor position
            await simulateReactInputTyping(el, text, delayMs, /* clear */ false);
        } else if (el instanceof HTMLElement) {
            // Check for Lexical editor (on the element itself or an ancestor)
            const lexicalEl = el.closest('[data-lexical-editor]') || (el.hasAttribute('data-lexical-editor') ? el : null);
            if (lexicalEl && lexicalEl instanceof HTMLElement) {
                elementInfo.strategy = 'lexical';
                await typeIntoLexicalEditor(lexicalEl, text, delayMs);
            }
            // Check for Slate editor
            else {
                const slateEl = el.closest('[data-slate-editor]') || (el.hasAttribute('data-slate-editor') ? el : null);
                if (slateEl && slateEl instanceof HTMLElement) {
                    elementInfo.strategy = 'slate';
                    await typeIntoSlateEditor(slateEl, text, delayMs);
                }
                // Generic contentEditable
                else if (el.isContentEditable) {
                    elementInfo.strategy = 'contenteditable';
                    await typeIntoContentEditable(el, text, delayMs);
                }
                // Last resort: try execCommand on focused element
                else {
                    elementInfo.strategy = 'execCommand-fallback';
                    el.focus();
                    const inserted = document.execCommand('insertText', false, text);
                    if (!inserted) {
                        throw new Error(`Cannot type into focused <${el.tagName.toLowerCase()}> element — it is not an editable field.`);
                    }
                }
            }
        } else {
            throw new Error(`Cannot type into focused <${el.tagName.toLowerCase()}> element — unsupported element type.`);
        }

        await emitResponse('type-into-focused-response', correlationId, JSON.stringify({
            success: true,
            data: {
                element: elementInfo,
                charsTyped: text.length,
            }
        }));
    } catch (error) {
        await emitResponse('type-into-focused-response', correlationId, JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        }));
    }
}

// --- press_key handler ---
// Dispatches synthetic keydown/keyup events (with modifier flags) to a target
// element. Synthetic events are untrusted so the browser will NOT perform
// native default actions — the common ones (text insertion, Enter submit,
// Tab focus traversal, Backspace/Delete) are emulated when the app's own
// handlers don't call preventDefault().

const NAMED_KEY_CODES: Record<string, string> = {
    Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace',
    Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space',
    F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
    F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
};

function codeForKey(key: string): string {
    if (NAMED_KEY_CODES[key]) return NAMED_KEY_CODES[key];
    if (key.length === 1) {
        if (/[a-zA-Z]/.test(key)) return 'Key' + key.toUpperCase();
        if (/[0-9]/.test(key)) return 'Digit' + key;
    }
    return '';
}

function tabbableElements(): HTMLElement[] {
    const sel = 'a[href], button, input, textarea, select, summary, [tabindex]';
    return Array.from(document.querySelectorAll(sel))
        .filter((el): el is HTMLElement => el instanceof HTMLElement)
        .filter(el => !el.hasAttribute('disabled') && el.tabIndex !== -1 && isElementVisible(el));
}

function emulateDefaultKeyAction(el: Element, key: string, shift: boolean) {
    const isTextInput = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    const isEditable = isTextInput || (el instanceof HTMLElement && el.isContentEditable);

    if (key.length === 1) {
        if (isEditable) document.execCommand('insertText', false, key);
        return;
    }
    switch (key) {
        case 'Enter':
            if (el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) {
                document.execCommand('insertText', false, '\n');
            } else if (el instanceof HTMLInputElement && el.form) {
                if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
                else el.form.submit();
            } else if (el instanceof HTMLElement && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button')) {
                el.click();
            }
            break;
        case 'Tab': {
            const tabbables = tabbableElements();
            if (tabbables.length === 0) break;
            const idx = tabbables.indexOf(el as HTMLElement);
            const next = shift
                ? tabbables[(idx <= 0 ? tabbables.length : idx) - 1]
                : tabbables[(idx + 1) % tabbables.length];
            if (next) {
                next.focus();
                if (isTypeable(next)) _lastFocusedElement = next;
            }
            break;
        }
        case 'Backspace':
            if (isEditable) document.execCommand('delete', false);
            break;
        case 'Delete':
            if (isEditable) document.execCommand('forwardDelete', false);
            break;
    }
}

async function handlePressKeyRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received press-key, payload:', event.payload);
    const correlationId = getCorrelationId(event.payload);

    // Dedup guard: key presses are stateful, never process twice
    if (correlationId && _handledCorrelationIds.has(correlationId)) {
        console.warn('TAURI-PLUGIN-MCP: Ignoring duplicate press-key for correlation ID:', correlationId);
        return;
    }
    if (correlationId) {
        _handledCorrelationIds.add(correlationId);
        setTimeout(() => _handledCorrelationIds.delete(correlationId), 30000);
    }

    try {
        // Rust forwards omitted optional fields as JSON null (not undefined),
        // so `= []` destructuring defaults don't apply — coalesce explicitly.
        const p = event.payload || {};
        const rawKey = p.key;
        const modifiers: string[] = Array.isArray(p.modifiers) ? p.modifiers : [];
        const repeat = (typeof p.repeat === 'number' && p.repeat > 0) ? p.repeat : 1;
        const selectorType = p.selectorType || null;
        const selectorValue = p.selectorValue || null;
        if (!rawKey || typeof rawKey !== 'string') {
            throw new Error('key parameter is required (e.g. "Escape", "Enter", "Tab", "ArrowDown", or a single character)');
        }
        const key = rawKey === 'Space' ? ' ' : rawKey;

        // Resolve target: explicit selector > active element > last focused > body
        let target: Element | null = null;
        if (selectorType && selectorValue) {
            target = resolveElement({
                ref: selectorType === 'ref' ? parseInt(selectorValue, 10) : undefined,
                selectorType: selectorType === 'ref' ? undefined : selectorType,
                selectorValue,
            });
            if (!target) {
                throw new Error(`Element with ${selectorType}="${selectorValue}" not found. ${selectorType === 'ref' ? 'Call query_page (mode=map) first to populate refs.' : ''}`);
            }
            if (target instanceof HTMLElement) target.focus();
        } else {
            target = (document.activeElement && document.activeElement !== document.body)
                ? document.activeElement
                : (_lastFocusedElement || document.body);
        }

        const mods = new Set(modifiers.map(m => String(m).toLowerCase()));
        const eventInit: KeyboardEventInit = {
            key,
            code: codeForKey(key),
            bubbles: true,
            cancelable: true,
            composed: true,
            ctrlKey: mods.has('ctrl') || mods.has('control'),
            metaKey: mods.has('cmd') || mods.has('meta') || mods.has('command'),
            shiftKey: mods.has('shift'),
            altKey: mods.has('alt') || mods.has('option'),
        };
        const hasCtrlOrMeta = !!(eventInit.ctrlKey || eventInit.metaKey);
        const count = Math.max(1, Math.min(100, Number(repeat) || 1));
        let lastDefaultPrevented = false;

        for (let i = 0; i < count; i++) {
            // Re-resolve the active element each press — Tab/Enter can move focus
            const el = (document.activeElement && document.activeElement !== document.body)
                ? document.activeElement
                : (target || document.body);
            const kd = new KeyboardEvent('keydown', eventInit);
            const proceed = el.dispatchEvent(kd);
            lastDefaultPrevented = !proceed;

            if (proceed && !hasCtrlOrMeta && !eventInit.altKey) {
                emulateDefaultKeyAction(el, key, eventInit.shiftKey === true);
            }

            el.dispatchEvent(new KeyboardEvent('keyup', eventInit));
            if (i < count - 1) await new Promise(r => setTimeout(r, 30));
        }

        const finalTarget = document.activeElement || target;
        await emitResponse('press-key-response', correlationId, JSON.stringify({
            success: true,
            data: {
                key: rawKey,
                code: eventInit.code,
                modifiers: Array.from(mods),
                repeat: count,
                defaultPrevented: lastDefaultPrevented,
                target: finalTarget ? {
                    tag: finalTarget.tagName.toLowerCase(),
                    id: (finalTarget as HTMLElement).id || undefined,
                } : null,
            }
        }));
    } catch (error) {
        await emitResponse('press-key-response', correlationId, JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        })).catch(e => console.error('TAURI-PLUGIN-MCP: Error emitting error response', e));
    }
}

// --- set_file_input handler ---
// Attaches files (sent base64-encoded from the MCP server) to an
// <input type="file"> via DataTransfer, since the native file chooser
// cannot be driven programmatically from inside the webview.
async function handleSetFileInputRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received set-file-input');
    const correlationId = getCorrelationId(event.payload);

    // Dedup guard
    if (correlationId && _handledCorrelationIds.has(correlationId)) {
        console.warn('TAURI-PLUGIN-MCP: Ignoring duplicate set-file-input for correlation ID:', correlationId);
        return;
    }
    if (correlationId) {
        _handledCorrelationIds.add(correlationId);
        setTimeout(() => _handledCorrelationIds.delete(correlationId), 30000);
    }

    try {
        const { selectorType, selectorValue, files } = event.payload || {};
        if (!Array.isArray(files) || files.length === 0) {
            throw new Error('files array is required');
        }
        if (!selectorType || !selectorValue) {
            throw new Error('selectorType and selectorValue are required to target the file input');
        }

        const element = resolveElement({
            ref: selectorType === 'ref' ? parseInt(selectorValue, 10) : undefined,
            selectorType: selectorType === 'ref' ? undefined : selectorType,
            selectorValue,
        });
        if (!element) {
            throw new Error(`Element with ${selectorType}="${selectorValue}" not found.`);
        }

        // Accept the input itself, or a container/label holding one
        let input: HTMLInputElement | null = null;
        if (element instanceof HTMLInputElement && element.type === 'file') {
            input = element;
        } else {
            input = element.querySelector('input[type="file"]');
        }
        if (!input) {
            throw new Error(`Element <${element.tagName.toLowerCase()}> is not (and does not contain) an <input type="file">`);
        }

        if (files.length > 1 && !input.multiple) {
            throw new Error(`Input does not accept multiple files (got ${files.length}). Set the "multiple" attribute or send one file.`);
        }

        const dt = new DataTransfer();
        for (const f of files) {
            const binary = atob(f.dataBase64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            dt.items.add(new File([bytes], f.name, { type: f.mimeType || 'application/octet-stream' }));
        }
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        await emitResponse('set-file-input-response', correlationId, JSON.stringify({
            success: true,
            data: {
                filesAttached: files.map((f: any) => f.name),
                input: { id: input.id || undefined, name: input.name || undefined },
            }
        }));
    } catch (error) {
        await emitResponse('set-file-input-response', correlationId, JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        })).catch(e => console.error('TAURI-PLUGIN-MCP: Error emitting error response', e));
    }
}

// --- ipc_invoke handler (manage_ipc action=invoke) ---
// Invokes a Tauri command through the webview's real IPC path, so the call
// goes through the app's actual invoke pipeline (capability checks included)
// and is captured by the invoke wrapper like any frontend-originated call.
const MAX_IPC_RESULT_CHARS = 30000;

async function handleIpcInvokeRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received ipc-invoke, payload:', event.payload);
    const correlationId = getCorrelationId(event.payload);

    // Dedup guard: invoking a command twice could double-apply a mutation
    if (correlationId && _handledCorrelationIds.has(correlationId)) {
        console.warn('TAURI-PLUGIN-MCP: Ignoring duplicate ipc-invoke for correlation ID:', correlationId);
        return;
    }
    if (correlationId) {
        _handledCorrelationIds.add(correlationId);
        setTimeout(() => _handledCorrelationIds.delete(correlationId), 30000);
    }

    try {
        const { command, args, timeoutMs = 10000 } = event.payload || {};
        if (!command || typeof command !== 'string') {
            throw new Error('command parameter is required');
        }

        const started = Date.now();
        const result = await Promise.race([
            invoke(command, (args && typeof args === 'object') ? args : {}),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error(`invoke("${command}") timed out after ${timeoutMs}ms (the command may still be running)`)),
                timeoutMs
            )),
        ]);

        let serialized: string;
        try {
            serialized = result === undefined ? 'undefined'
                : (typeof result === 'string' ? result : JSON.stringify(result));
        } catch {
            serialized = String(result);
        }
        let truncated = false;
        if (serialized.length > MAX_IPC_RESULT_CHARS) {
            serialized = serialized.slice(0, MAX_IPC_RESULT_CHARS);
            truncated = true;
        }

        await emitResponse('ipc-invoke-response', correlationId, JSON.stringify({
            success: true,
            data: {
                command,
                result: serialized,
                resultType: typeof result,
                truncated: truncated || undefined,
                durationMs: Date.now() - started,
            }
        }));
    } catch (error) {
        // Tauri command errors are often plain objects/strings, not Errors
        let message: string;
        if (error instanceof Error) message = error.message;
        else if (typeof error === 'string') message = error;
        else {
            try { message = JSON.stringify(error); } catch { message = String(error); }
        }
        await emitResponse('ipc-invoke-response', correlationId, JSON.stringify({
            success: false,
            error: `invoke failed: ${message}`
        })).catch(e => console.error('TAURI-PLUGIN-MCP: Error emitting error response', e));
    }
}

async function handleNavigateWebviewRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received navigate-webview, payload:', event.payload);
    const correlationId = getCorrelationId(event.payload);
    try {
        const { action } = event.payload;
        if (action === 'back') {
            window.history.back();
            await emitResponse('navigate-webview-response', correlationId, JSON.stringify({
                success: true,
                data: { action: 'back' }
            }));
        } else if (action === 'forward') {
            window.history.forward();
            await emitResponse('navigate-webview-response', correlationId, JSON.stringify({
                success: true,
                data: { action: 'forward' }
            }));
        } else {
            await emitResponse('navigate-webview-response', correlationId, JSON.stringify({
                success: false,
                error: `Unknown navigate-webview action: ${action}`
            }));
        }
    } catch (error) {
        await emitResponse('navigate-webview-response', correlationId, JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        }));
    }
}

async function handleManageZoomRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received manage-zoom, payload:', event.payload);
    const correlationId = getCorrelationId(event.payload);
    try {
        const { action } = event.payload;
        if (action === 'get') {
            // Use visualViewport scale if available, fall back to devicePixelRatio-based detection
            const visualScale = (window as any).visualViewport?.scale ?? null;
            await emitResponse('manage-zoom-response', correlationId, JSON.stringify({
                success: true,
                data: {
                    devicePixelRatio: window.devicePixelRatio,
                    visualViewportScale: visualScale,
                }
            }));
        } else {
            await emitResponse('manage-zoom-response', correlationId, JSON.stringify({
                success: false,
                error: `Unknown manage-zoom action: ${action}`
            }));
        }
    } catch (error) {
        await emitResponse('manage-zoom-response', correlationId, JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        }));
    }
}