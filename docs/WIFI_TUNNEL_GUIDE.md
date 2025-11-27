# WiFi Tunnel Guide

This guide shows how to use `appium-ios-remotexpc` for WiFi tunneling to iOS devices.

## Prerequisites

1. **macOS** with OpenSSL installed
2. **pymobiledevice3** installed for initial pairing (`pip install pymobiledevice3`)
3. **iOS device** on the same WiFi network as your Mac
4. **Device previously paired** over USB (Trust dialog accepted)

## Quick Start

### Step 1: Initial USB Pairing (One-time Setup)

Connect your iOS device via USB and run:

```bash
sudo pymobiledevice3 remote start-tunnel
```

This will:
- Show a "Trust" dialog on your device - tap **Trust**
- Create pairing keys at `~/.pymobiledevice3/remote_<UDID>.plist`

Note your device UDID from the output (e.g., `00008030-001E290A3EF2402E`).

### Step 2: Import Pairing Keys

Disconnect USB and run:

```bash
cd appium-ios-remotexpc
sudo npx tsx scripts/test-wifi-tunnel.ts --import-keys <YOUR_UDID>
```

Example:
```bash
sudo npx tsx scripts/test-wifi-tunnel.ts --import-keys 00008030-001E290A3EF2402E
```

### Step 3: Start WiFi Tunnel

```bash
sudo npx tsx scripts/test-wifi-tunnel.ts
```

On success, you'll see:
```
🎉 WiFi tunnel ACTIVE and ready for RSD services!

   ╔════════════════════════════════════════════════════╗
   ║  RSD Connection Info                               ║
   ╠════════════════════════════════════════════════════╣
   ║  Address: fd14:974d:66b2::1                        ║
   ║  Port:    49174                                    ║
   ╚════════════════════════════════════════════════════╝
```

**Keep this terminal running** - the tunnel stays active until you press Ctrl+C.

### Step 4: Test RSD Services

In a **new terminal**, test the connection:

```bash
cd appium-ios-remotexpc
sudo npx tsx scripts/test-wifi-rsd-services.ts <ADDRESS> <PORT>
```

Example:
```bash
sudo npx tsx scripts/test-wifi-rsd-services.ts fd14:974d:66b2::1 49174
```

This will:
1. Connect to RSD and list available services
2. Test location simulation (sets device location to Apple Park, then clears it)

---

## Available Commands

### Discover WiFi Devices
```bash
sudo npx tsx scripts/test-wifi-tunnel.ts --discover-only
```

### List Stored Pairing Records
```bash
sudo npx tsx scripts/test-wifi-tunnel.ts --list-records
```

### Full Tunnel Connection
```bash
sudo npx tsx scripts/test-wifi-tunnel.ts
```

### Test RSD Services
```bash
sudo npx tsx scripts/test-wifi-rsd-services.ts <rsd-address> <rsd-port>
```

---

## Troubleshooting

### "No WiFi devices found"
- Ensure iOS device and Mac are on the same WiFi network
- Disconnect USB cable (USB and WiFi can conflict)
- Restart the device

### "No pairing record found"
- First pair over USB using `sudo pymobiledevice3 remote start-tunnel`
- Import keys with `--import-keys <UDID>`

### Connection Timeout
- Check if device is unlocked
- Ensure no firewall is blocking local network connections
- Try restarting the device

---

## How It Works

1. **Bonjour Discovery**: Finds devices advertising `_remotepairing._tcp` service
2. **Pairing Verification**: Uses stored Ed25519/X25519 keys to authenticate
3. **TLS-PSK Tunnel**: Establishes encrypted tunnel using ChaCha20-Poly1305
4. **TUN Interface**: Creates virtual network interface for packet forwarding
5. **RSD Services**: Exposes device services (DVT, WebInspector, etc.) over IPv6

