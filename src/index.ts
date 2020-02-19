import noble from "@abandonware/noble"

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
    efd658aec402ef3376e791b00019103b: "voc"
}

const boardsConnected: { [key: string]: ThunderSense } = {}

class ThunderSense {
    ledChar: noble.Characteristic | null = null
    chars: noble.Characteristic[] = []
    readings: { [key: string]: number } = {}
    readInterval: any = null

    set(name: string, value: number) {
        this.readings[name] = value
    }

    constructor(public address: string, public name: string) {
        boardsConnected[this.address] = this
        this.readInterval = setInterval(this.readAll, 10000)
    }

    disconnect() {
        clearInterval(this.readInterval)
        delete boardsConnected[this.address]
    }

    setLedColor(r: number, g: number, b: number) {
        if (!this.ledChar) return

        const data = Buffer.from([0x0f, r, g, b])
        this.ledChar.write(data, true, error => {
            if (error) console.log("error writing led:", error)
        })
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

    reading = 0
    readAll = () => {
        if (this.reading > 0) return

        let at = 0
        const readOne: () => void = () => {
            const char = this.chars[at++]
            if (!char) {
                if (this.reading > 0) throw Error("oeps")
                return console.log(this.address, this.name, this.readings)
            }

            const name = KnownCharacteristics[char.uuid]
            const converter = ((this as unknown) as { [key: string]: (data: Buffer) => number })[name]
            if (!converter) return readOne()

            this.reading += 1
            char.read((error, data) => {
                this.reading -= 1
                if (error) {
                    console.log("had error reading:", name, "error:", error)
                } else {
                    this.set(name, converter(data))
                }
                readOne()
            })
        }
        readOne()
    }

    addCharacteristic(char: noble.Characteristic) {
        const uuid = char.uuid
        if (uuid === "fcb89c40c60359f37dc35ece444a401b") {
            this.ledChar = char
            this.setLedColor(255, 255, 255)
        }

        const name = KnownCharacteristics[uuid]
        if (!name) return

        this.chars.push(char)
    }
}

console.log("scanning...")
noble.startScanning([], true)
noble.on("discover", peripheral => {
    const address = peripheral.address
    if (!address) {
        // console.log("ignoring device without address")
        return
    }

    const localName = peripheral.advertisement.localName
    if (!(localName && localName.startsWith("Thunder Sense"))) {
        // console.log("ignoring", address, localName)
        return
    }

    if (boardsConnected[address]) {
        // console.log("ignoring already connected sense:", address)
        return
    }

    const sense = new ThunderSense(address, localName)
    console.log("discovered:", address)

    peripheral.connect(error => {
        if (error) return console.log("1 error:", error)

        peripheral.on("disconnect", () => {
            console.log("disconnected:", address)
            sense.disconnect()
        })

        console.log("connected:", address)

        peripheral.discoverServices([], (error, services) => {
            if (error) return console.log("2 error:", error)

            for (const service of services) {
                service.discoverCharacteristics([], function(error, characteristics) {
                    if (error) return console.log("3 error:", error)

                    for (var i in characteristics) {
                        sense.addCharacteristic(characteristics[i])
                    }
                })
            }
        })
    })
})
