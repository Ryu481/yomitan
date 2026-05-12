//
//  SafariWebExtensionHandler.swift
//  Yomitan Safari Extension
//

import Foundation
import SafariServices
import os.log
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        guard let body = message as? [String: Any] else {
            os_log(.error, "Received invalid native message payload from Safari web extension")
            complete(context: context, response: ["error": "Invalid native message payload"])
            return
        }

        handle(message: body, context: context)
    }

    private func handle(message: [String: Any], context: NSExtensionContext) {
        guard let action = message["action"] as? String else {
            complete(context: context, response: ["error": "Missing action"])
            return
        }

        switch action {
            case "getClipboard":
                getClipboard(context: context)
            default:
                complete(context: context, response: ["error": "Unsupported action: " + action])
        }
    }

private func getClipboard(context: NSExtensionContext) {
    #if os(macOS)
    let pasteboard = NSPasteboard.general
    let changeCount = pasteboard.changeCount
    let text = pasteboard.string(forType: .string) ?? ""
    let clipboardAvailable = true
    #elseif os(iOS)
    let pasteboard = UIPasteboard.general
    let changeCount = pasteboard.changeCount
    let text = pasteboard.string ?? ""
    let clipboardAvailable = true
    #else
    let changeCount = 0
    let text = ""
    let clipboardAvailable = false
    #endif

    complete(context: context, response: [
        "ok": clipboardAvailable,
        "text": text,
        "version": changeCount,
        "updatedAt": Date().timeIntervalSince1970,
        "source": "SafariWebExtensionHandler"
    ])
}

    private func complete(context: NSExtensionContext, response: [String: Any]) {
        let item = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            item.userInfo = [SFExtensionMessageKey: response]
        } else {
            item.userInfo = ["message": response]
        }
        context.completeRequest(returningItems: [item], completionHandler: nil)
    }
}
