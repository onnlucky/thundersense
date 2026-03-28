import * as fs from "fs"
import * as path from "path"
import noble from "@abandonware/noble"
import { default as HomeAssistant } from "homeassistant"

let config = {}
try {
    const file = path.join(process.env.HOME || "/home/homeassistant", "thundersense-to-homeassistant.config.json")
    config = JSON.parse(fs.readFileSync(file, {encoding: "utf8"}))
} catch (e) {
    console.error("failed to read config:", e)
}

const hass = new HomeAssistant(config)

const KnownCharacteristics: { [key: string]: string } = {
    "2a19": "battery",
    ec61a454ed01a5e8b8f9de9ec026ec51: "power",
    "2a6e": "temperature",
    "2a6f": "humidity",
    "2a76": "uvIndex",
    "2a6d": "pressure",
    c8546913bfd945eb8dde9f8754f4a32e: "ambientLight",
    c8546913bf0245eb8dde9f8754f4a32e: "sound",
    efd658aec401ef3376e791b00019103b: "co2",
    efd658aec402ef3376e791b00019103b: "voc",
    fcb89c40c60359f37dc35ece444a401b: "led",
}

// 00:0B:57:1A:8A:EB office ...

let boardsConnected: { [key: string]: ThunderSense } = {}
let lastRead = Date.now()

class ThunderSense {
    disconnected = false
    ready = false
    ledChar: noble.Characteristic | null = null
    chars: noble.Characteristic[] = []
    readings: { [key: string]: number } = {}
    readInterval: any = null

    set(name: string, value: number) {
        this.readings[name] = value
    }

    constructor(public peripheral: noble.Peripheral, public address: string, public name: string) {
        boardsConnected[this.address] = this
    }

    async connect() {
        if (this.disconnected) return

        this.ready = true
        this.readInterval = setInterval(this.readAll, 10000)
        await new Promise((resolve) => setTimeout(resolve, 250))
        await this.readAll()
        await this.setLedColor(0, 100, 0)
    }

    disconnect(fromDisconnectEvent = false) {
        if (boardsConnected[this.address] === this) {
            delete boardsConnected[this.address]
        }

        if (this.disconnected) return

        this.disconnected = true
        clearInterval(this.readInterval)
        if (!fromDisconnectEvent) {
            this.peripheral.disconnect()
        }
    }

    async setLedColor(r: number, g: number, b: number) {
        if (!this.ledChar) return

        const off = r <= 0 && g <= 0 && b <= 0
        const mask = off ? 0x0 : 0x2 // only far right bottom led, else temperature goes up
        const data = Buffer.from([mask, r, g, b])
        await this.ledChar.writeAsync(data, false)
    }

    battery(data: Buffer): number {
        return data.readInt8(0)
    }

    power(data: Buffer): number {
        return data.readInt8(0)
    }

    temperature(data: Buffer): number {
        return data.readInt16LE(0) / 100
    }

    humidity(data: Buffer): number {
        return data.readInt16LE(0) / 100
    }

    pressure(data: Buffer): number {
        return data.readUInt32LE(0) / 1000
    }

    uvIndex(data: Buffer): number {
        return data.readUInt8(0)
    }

    ambientLight(data: Buffer): number {
        return data.readUInt32LE(0) / 100
    }

    sound(data: Buffer): number {
        return data.readInt16LE(0) / 100
    }

    voc(data: Buffer): number {
        return data.readUInt16LE(0)
    }

    co2(data: Buffer): number {
        return data.readUInt16LE(0)
    }

    readStartTime = 0
    readAll = async () => {
        if (this.readStartTime) {
            const readingStarted = (Date.now() - this.readStartTime) / 1000
            if (readingStarted > 10) {
                console.warn(this.address, "timeout in readAll:", readingStarted)
                this.disconnect()
            }
            return
        }

        this.readStartTime = Date.now()

        try {
            let update = false
            const readings: { [key: string]: number } = {}
            for (const characteristic of this.chars) {
                const name = KnownCharacteristics[characteristic.uuid]
                const converter = (this as unknown as { [key: string]: (data: Buffer) => number })[name]
                if (!converter) continue

                const data = await characteristic.readAsync()
                update = true
                readings[name] = converter(data)
            }

            if (!update) return
            if (this.disconnected) return

            lastRead = Date.now()

            for (const [name, state] of Object.entries(readings)) {
                let attributes: Record<string, string> | undefined
                switch (name) {
                    case "temperature":
                        attributes = {
                            state_class: "measurement",
                            device_class: "temperature",
                            unit_of_measurement: "°C",
                        }
                        break
                    case "humidity":
                        attributes = {
                            state_class: "measurement",
                            device_class: "humidity",
                            unit_of_measurement: "%",
                        }
                        break
                    case "voc":
                        attributes = {
                            state_class: "measurement",
                            device_class: "volatile_organic_compounds",
                            unit_of_measurement: "µg/m³",
                        }
                        break
                    case "co2":
                        attributes = {
                            state_class: "measurement",
                            device_class: "carbon_dioxide",
                            unit_of_measurement: "ppm",
                        }
                        break
                }
                if (!attributes) continue

                const sensor = "thundersense_" + this.address + "_" + name
                console.log(sensor, "read", state)
                if (process.env.NODE_ENV !== "production") continue
                await hass.states.update("sensor", sensor, { state, attributes })
            }
        } catch (e) {
            console.error(this.address, "error in readAll:", e)
        } finally {
            const readingStarted = (Date.now() - this.readStartTime) / 1000
            console.log(this.address, "readAll took:", readingStarted)
            this.readStartTime = 0
        }
    }

    addCharacteristic(char: noble.Characteristic) {
        const name = KnownCharacteristics[char.uuid]
        if (!name) return

        if (name === "led") {
            this.ledChar = char
        } else {
            this.chars.push(char)
        }
    }
}

function startBluetoothScanning() {
    noble.on("stateChange", (state) => {
        console.debug("state change:", state)
        if (state === "poweredOn") {
            boardsConnected = {}
            noble.startScanning([], false)
        } else {
            noble.stopScanning()
        }
    })

    let discoverStartTime = 0
    noble.on("discover", async (peripheral) => {
        try {
            if (discoverStartTime) {
                console.debug(peripheral.uuid, "discovery of a second device...")
                return
            }

            discoverStartTime = Date.now()
            noble.stopScanning()
            if (await discover(peripheral)) {
                const duration = (Date.now() - discoverStartTime) / 1000
                console.debug(peripheral.uuid, "discover took:", duration)
            }
        } catch (e) {
            console.error(peripheral.uuid, "error in discovery:", e)
        } finally {
            discoverStartTime = 0
            noble.startScanning([], false)
        }
    })

    setInterval(() => {
        const lastReadDuration = (Date.now() - lastRead) / 1000
        if (lastReadDuration > 60) {
            console.log("not getting any readings in", lastReadDuration, "seconds, exiting")
            process.exit(1)
        }

        const discoverDuration = (Date.now() - discoverStartTime) / 1000
        if (discoverDuration > 10) {
            console.debug("timeout in discovery:", discoverDuration)
            discoverStartTime = 0
        } else if (discoverStartTime) {
            return
        }
        console.debug("reset scanning")
        noble.stopScanning()
        noble.startScanning([], false)
    }, 30 * 1000)

    console.debug("started bluetooth scanning...")
}

async function discover(peripheral: noble.Peripheral) {
    const address = peripheral.uuid
    const localName = peripheral.advertisement.localName
    if (!(address && localName && localName.startsWith("Thunder Sense"))) {
        // log.trace("ignoring", address, localName)
        return
    }

    if (boardsConnected[address]) {
        console.debug("discovery of an already connected sense:", address, "...waiting")
        await new Promise((resolve) => setTimeout(resolve, 250))
        if (boardsConnected[address]) {
            console.debug("ignoring discovery of an already connected sense:", address)
            return
        }
    }

    const sense = new ThunderSense(peripheral, address, localName)
    console.debug("discovered:", address, localName)

    peripheral.once("disconnect", () => {
        console.debug(address, "on disconnect", sense.disconnected ? " - already disconnected" : "")
        peripheral.removeAllListeners("disconnect")
        peripheral.removeAllListeners("servicesDiscover")
        sense.disconnect(true /* fromDisconnectEvent */)
    })

    setTimeout(() => {
        if (sense.ready) return
        if (sense.disconnected) return
        console.debug(address, "failed to connect within 20 seconds")
        peripheral.removeAllListeners("disconnect")
        peripheral.removeAllListeners("servicesDiscover")
        sense.disconnect()
    }, 10 * 1000)

    await peripheral.connectAsync()
    if (sense.disconnected) return

    console.debug(address, "connected ... discovering services ...")

    const services = await peripheral.discoverServicesAsync([])
    for (const service of services) {
        if (sense.disconnected) return
        const characteristics = await service.discoverCharacteristicsAsync([])
        if (sense.disconnected) return
        for (const characteristic of characteristics) {
            sense.addCharacteristic(characteristic)
        }
    }

    console.debug(address, "ready")
    await sense.connect()
    return true
}

startBluetoothScanning()
