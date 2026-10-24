'use strict';

const dns = require('dns').promises;
const net = require('net');
const url = require('url');

/**
 * Checks if an IP address is private, loopback, or reserved (SSRF protection)
 */
function isPrivateIP(ip) {
    if (!ip) return true;

    // IPv4 check
    if (net.isIPv4(ip)) {
        const parts = ip.split('.').map(Number);
        
        // 0.0.0.0/8 (Current network)
        if (parts[0] === 0) return true;
        // 10.0.0.0/8 (Private)
        if (parts[0] === 10) return true;
        // 127.0.0.0/8 (Loopback)
        if (parts[0] === 127) return true;
        // 169.254.0.0/16 (Link-local / AWS metadata)
        if (parts[0] === 169 && parts[1] === 254) return true;
        // 172.16.0.0/12 (Private)
        if (parts[0] === 172 && (parts[1] >= 16 && parts[1] <= 31)) return true;
        // 192.168.0.0/16 (Private)
        if (parts[0] === 192 && parts[1] === 168) return true;
        // 224.0.0.0/4 (Multicast)
        if (parts[0] >= 224 && parts[0] <= 239) return true;
        // 240.0.0.0/4 (Reserved)
        if (parts[0] >= 240) return true;

        return false;
    }

    // IPv6 check
    if (net.isIPv6(ip)) {
        const normalized = ip.toLowerCase();
        if (normalized === '::1' || normalized === '::') return true;
        // fc00::/7 (Unique local address)
        if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
        // fe80::/10 (Link-local address)
        if (normalized.startsWith('fe80') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
        // IPv4-mapped IPv6 (::ffff:127.0.0.1)
        if (normalized.includes('::ffff:')) {
            const v4Part = normalized.split('::ffff:')[1];
            if (v4Part && net.isIPv4(v4Part)) {
                return isPrivateIP(v4Part);
            }
        }
        return false;
    }

    return true;
}

/**
 * Validates a target URL against SSRF attacks.
 * Allows localhost ONLY when allowLocalhost is explicitly true (for sandbox/dev mode).
 */
async function validateSafeUrl(targetUrl, allowLocalhost = false) {
    if (!targetUrl || typeof targetUrl !== 'string') {
        throw new Error('URL tujuan tidak valid');
    }

    let parsed;
    try {
        parsed = new url.URL(targetUrl);
    } catch (e) {
        throw new Error('Format URL tidak valid: ' + e.message);
    }

    // Only allow http and https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Protokol URL tidak diizinkan. Hanya HTTPS atau HTTP yang diperbolehkan.');
    }

    // In production, enforce HTTPS
    if (!allowLocalhost && parsed.protocol !== 'https:') {
        throw new Error('Callback URL wajib menggunakan protokol HTTPS di lingkungan live/produksi.');
    }

    const hostname = parsed.hostname;

    // Check if hostname is an explicit IP
    if (net.isIP(hostname)) {
        if (!allowLocalhost && isPrivateIP(hostname)) {
            throw new Error(`Alamat IP privat atau lokal tidak diizinkan untuk webhook (${hostname})`);
        }
        return parsed.toString();
    }

    // Localhost checks
    if (hostname.toLowerCase() === 'localhost' || hostname.toLowerCase().endsWith('.localhost')) {
        if (!allowLocalhost) {
            throw new Error('Host localhost tidak diizinkan untuk webhook produksi.');
        }
        return parsed.toString();
    }

    // Resolve DNS to verify the underlying IP
    try {
        const addresses = await dns.lookup(hostname, { all: true });
        for (const addr of addresses) {
            if (!allowLocalhost && isPrivateIP(addr.address)) {
                throw new Error(`Hostname ${hostname} teresolusi ke IP privat (${addr.address}), akses ditolak.`);
            }
        }
    } catch (err) {
        if (err.message.includes('teresolusi')) throw err;
        if (!allowLocalhost) {
            throw new Error(`Gagal memverifikasi DNS untuk host ${hostname}: ${err.message}`);
        }
    }

    return parsed.toString();
}

module.exports = {
    isPrivateIP,
    validateSafeUrl
};
