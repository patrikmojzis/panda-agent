import Foundation
import Security

protocol TokenSecretStoring {
    func loadToken(agentKey: String, deviceId: String) throws -> String?
    func saveToken(_ token: String, agentKey: String, deviceId: String) throws
    func deleteAllTokens() throws
}

struct KeychainTokenStore: TokenSecretStoring {
    private let service = "\(AppIdentity.bundleIdentifier).telepathy-token"

    private func account(agentKey: String, deviceId: String) -> String {
        "\(agentKey)::\(deviceId)"
    }

    private func baseQuery(agentKey: String, deviceId: String) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account(agentKey: agentKey, deviceId: deviceId),
            kSecAttrSynchronizable: kCFBooleanFalse as Any,
        ]
    }

    private func keychainError(_ status: OSStatus, action: String) -> ReceiverError {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
        return ReceiverError("Could not \(action) Telepathy token in Keychain: \(message)")
    }

    func loadToken(agentKey: String, deviceId: String) throws -> String? {
        var query = baseQuery(agentKey: agentKey, deviceId: deviceId)
        query[kSecMatchLimit] = kSecMatchLimitOne
        query[kSecReturnData] = kCFBooleanTrue

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }

        guard status == errSecSuccess else {
            throw keychainError(status, action: "read")
        }

        guard let data = result as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ReceiverError("Telepathy token in Keychain is unreadable")
        }

        return token
    }

    func saveToken(_ token: String, agentKey: String, deviceId: String) throws {
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedToken.isEmpty else {
            throw ReceiverError("Telepathy token must not be empty")
        }

        let data = Data(trimmedToken.utf8)
        let query = baseQuery(agentKey: agentKey, deviceId: deviceId)
        let updateStatus = SecItemUpdate(query as CFDictionary, [
            kSecValueData: data,
        ] as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }

        if updateStatus != errSecItemNotFound {
            throw keychainError(updateStatus, action: "update")
        }

        var addQuery = query
        addQuery[kSecValueData] = data
        addQuery[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw keychainError(addStatus, action: "save")
        }
    }

    func deleteAllTokens() throws {
        let status = SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
        ] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw keychainError(status, action: "delete")
        }
    }
}
