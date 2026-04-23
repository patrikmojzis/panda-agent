import Darwin
import Foundation

final class TunnelSupervisor {
    private let remoteURL: URL
    private let config: TunnelConfig
    private let process = Process()
    private let stderrPipe = Pipe()

    init(remoteURL: URL, config: TunnelConfig) {
        self.remoteURL = remoteURL
        self.config = config
    }

    var destination: String {
        config.destination
    }

    var localURL: URL {
        var components = URLComponents(url: remoteURL, resolvingAgainstBaseURL: false) ?? URLComponents()
        components.host = "127.0.0.1"
        components.port = Int(config.localPort)
        return components.url ?? remoteURL
    }

    func start() throws {
        guard let remoteHost = remoteURL.host else {
            throw ReceiverError("Server URL must include a host and port for SSH tunnel mode")
        }
        let remotePort = remoteURL.port ?? defaultPort(for: remoteURL)
        guard let remotePort else {
            throw ReceiverError("Server URL must include a host and port for SSH tunnel mode")
        }

        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = [
            "-NT",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=10",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=3",
            "-o", "StrictHostKeyChecking=accept-new",
            "-p", String(config.sshPort),
            "-L", "127.0.0.1:\(config.localPort):\(remoteHost):\(remotePort)",
            destination,
        ]
        process.standardError = stderrPipe

        try process.run()

        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if !process.isRunning {
                throw ReceiverError("SSH tunnel exited early: \(stderrOutput())")
            }

            if isLocalPortReady() {
                return
            }

            Thread.sleep(forTimeInterval: 0.1)
        }

        throw ReceiverError("SSH tunnel to \(destination) did not become ready in time")
    }

    func stop() {
        guard process.isRunning else {
            return
        }

        process.terminate()
        process.waitUntilExit()
    }

    private func stderrOutput() -> String {
        let data = stderrPipe.fileHandleForReading.availableData
        guard !data.isEmpty else {
            return "unknown SSH error"
        }

        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func isLocalPortReady() -> Bool {
        let socketHandle = socket(AF_INET, SOCK_STREAM, 0)
        guard socketHandle >= 0 else {
            return false
        }

        defer {
            close(socketHandle)
        }

        var timeout = timeval(tv_sec: 0, tv_usec: 200_000)
        withUnsafePointer(to: &timeout) { pointer in
            _ = setsockopt(
                socketHandle,
                SOL_SOCKET,
                SO_SNDTIMEO,
                pointer,
                socklen_t(MemoryLayout<timeval>.size)
            )
        }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(config.localPort).bigEndian
        _ = withUnsafeMutablePointer(to: &address.sin_addr) { pointer in
            inet_pton(AF_INET, "127.0.0.1", pointer)
        }

        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                connect(socketHandle, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }

        return result == 0
    }

    private func defaultPort(for url: URL) -> Int? {
        switch url.scheme?.lowercased() {
        case "ws":
            return 80
        case "wss":
            return 443
        default:
            return nil
        }
    }
}
