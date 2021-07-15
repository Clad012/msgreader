import { TypeEnum } from "./Reader";
import DataStream from "./DataStream";
import CONST from "./const";

export interface Entry {
    name: string;
    type: TypeEnum;

    binaryProvider?: () => ArrayLike<number>;
    length: number;

    children?: number[];
}

interface LiteEntry {
    entry: Entry;

    left: number;
    right: number;
    child: number;

    firstSector: number;
    isMini?: boolean;
}

function RoundUpto4096(num: number) {
    return (num + 4095) & (~4095);
}

function RoundUpto512(bytes: number) {
    return (bytes + 511) & (~511);
}

function RoundUpto64(bytes: number) {
    return (bytes + 63) & (~63);
}

class LiteFat {
    sectors: number[];

    constructor(source) {
        this.sectors = source;
    }

    allocate(count: number): number {
        const first = this.sectors.length;
        for (let x = 0; x < count; x++) {
            const next = (x + 1 === count) ? -2 : first + x + 1;
            this.sectors.push(next);
        }
        return first;
    }

    finalize(boundary: number): this {
        let num = (boundary - (this.sectors.length % boundary)) % boundary;
        for (; num >= 1; num -= 1) {
            this.sectors.push(-1);
        }
        return this;
    }

    count(): number {
        return this.sectors.length;
    }
}

class LiteBurner {
    liteEnts: LiteEntry[];
    fat: LiteFat;
    miniFat: LiteFat;
    array: ArrayBuffer;

    constructor(entries: Entry[]) {
        this.fat = new LiteFat([-3]);
        this.miniFat = new LiteFat([]);

        this.liteEnts = entries
            .map(
                it => ({
                    entry: it,
                    left: -1,
                    right: -1,
                    child: -1,
                    firstSector: 0,
                    isMini: it.length < 4096,
                })
            );

        this.buildTree(0);


        const entriesFirstSector = this.fat.allocate(RoundUpto512(128 * this.liteEnts.length) / 512);

        for (let liteEnt of this.liteEnts
            .filter(it => true
                && it.entry.type == TypeEnum.DOCUMENT
                && it.isMini === false
            )
        ) {
            liteEnt.firstSector = (liteEnt.entry.length === 0)
                ? -2
                : this.fat.allocate(RoundUpto512(liteEnt.entry.length) / 512);
        }

        for (let liteEnt of this.liteEnts
            .filter(it => true
                && it.entry.type == TypeEnum.DOCUMENT
                && it.isMini === true
            )
        ) {
            liteEnt.firstSector = (liteEnt.entry.length === 0)
                ? -2
                : this.miniFat.allocate(RoundUpto64(liteEnt.entry.length) / 64);
        }

        const firstMiniFatSector = this.fat.allocate(RoundUpto512(4 * this.miniFat.count()) / 512);
        const numMiniFatSectors = this.fat.count() - firstMiniFatSector;

        const bytesMiniFat = 64 * this.miniFat.count();

        const firstMiniDataSector = this.fat.allocate(RoundUpto512(bytesMiniFat) / 512);

        this.liteEnts[0].firstSector = firstMiniDataSector;

        const array = new ArrayBuffer(512 * (1 + this.fat.count()));
        const ds = new DataStream(array, 0, DataStream.LITTLE_ENDIAN);
        ds.dynamicSize = false;

        if (this.fat.finalize(512 / 4).count() > 128) {
            throw new Error("FAT overflowed!");
        }

        this.miniFat.finalize(512 / 4);

        // header

        {
            ds.seek(0);
            ds.writeUint8Array(CONST.FILE_HEADER);
            ds.seek(0x18);
            ds.writeUint16(0x3E); //ushort MinorVersion
            ds.writeUint16(0x03); //ushort MajorVersion
            ds.writeUint16(0xFFFE); //ushort ByteOrder
            ds.writeUint16(9); //ushort SectorShift
            ds.writeUint16(6); //ushort MiniSectorShift

            ds.seek(0x2C);
            ds.writeInt32(1); //int32 NumberOfFATSectors
            ds.writeInt32(entriesFirstSector); //int32 FirstDirectorySectorLocation

            ds.seek(0x38);
            ds.writeInt32(4096); //int32 MiniStreamCutoffSize
            ds.writeInt32(firstMiniFatSector); //int32 FirstMiniFATSectorLocation
            ds.writeInt32(numMiniFatSectors); //int32 NumberOfMiniFATSectors
            ds.writeInt32(-2); //int32 FirstDIFATSectorLocation

            ds.seek(0x4C);
            ds.writeInt32(0); //int32 DIFAT[0]
            for (let x = 1; x < 109; x++) {
                ds.writeInt32(-1); //int32 DIFAT[x]
            }
        }

        // fat

        ds.seek(512 * (1));
        ds.writeInt32Array(this.fat.sectors);

        // entries

        for (let x = 0; x < this.liteEnts.length; x++) {
            const liteEnt = this.liteEnts[x];
            const pos = 512 * (1 + entriesFirstSector) + 128 * x;

            ds.seek(pos);
            ds.writeUCS2String(liteEnt.entry.name, null, null);
            const numBytesName = ds.position - pos;

            ds.seek(pos + 0x40);
            ds.writeUint16(Math.min(64, numBytesName + 2));
            ds.writeUint8(liteEnt.entry.type);
            ds.writeUint8((x === 0) ? 0 : 1);
            ds.writeInt32(liteEnt.left);
            ds.writeInt32(liteEnt.right);
            ds.writeInt32(liteEnt.child);

            if (x === 0) {
                ds.seek(pos + 0x50);
                ds.writeUint8Array([0x0B, 0x0D, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]);
            }

            const length = (x === 0)
                ? bytesMiniFat
                : liteEnt.entry.length;

            ds.seek(pos + 0x74);
            ds.writeInt32(liteEnt.firstSector);
            ds.writeInt32(length);
        }

        for (let liteEnt of this.liteEnts
            .filter(it => true
                && it.entry.type == TypeEnum.DOCUMENT
                && it.isMini === false
            )
        ) {
            const bytes = liteEnt.entry.binaryProvider();
            ds.seek(512 * (1 + liteEnt.firstSector));
            ds.writeUint8Array(bytes);
        }

        for (let liteEnt of this.liteEnts
            .filter(it => true
                && it.entry.type == TypeEnum.DOCUMENT
                && it.isMini === true
            )
        ) {
            const bytes = liteEnt.entry.binaryProvider();
            ds.seek(512 * (1 + firstMiniDataSector) + 64 * liteEnt.firstSector);
            ds.writeUint8Array(bytes);
        }

        // minifat

        ds.seek(512 * (1 + firstMiniFatSector));
        ds.writeInt32Array(this.miniFat.sectors);

        this.array = array;
    }

    /**
     * CFBF dedicated name comparer
     * 
     * - At first compare UTF-16 length.
     * - Then compare upper cased UTF-16 string.
     */
    private compareName(a: string, b: string): number {
        let t = a.length - b.length;
        if (t === 0) {
            const x = a.toUpperCase();
            const y = b.toUpperCase();
            if (x > y) {
                t = 1;
            }
            else if (x < y) {
                t = -1;
            }
        }
        return t;
    }

    private buildTree(dirIndex: number) {
        const { liteEnts } = this;
        const liteEntry = liteEnts[dirIndex];

        if (liteEntry.entry.type === TypeEnum.DOCUMENT) {
            throw new Error("It must be a storage!");
        }

        const children = liteEntry.entry.children.concat();
        if (children.length >= 1) {
            children.sort(
                (a, b) => {
                    return this.compareName(
                        liteEnts[a].entry.name,
                        liteEnts[b].entry.name
                    );
                }
            );

            liteEntry.child = children[0];

            for (let x = 0; x < children.length - 1; x++) {
                liteEnts[children[x]].right = children[x + 1];
            }

            for (let subIndex of children
                .filter(it => liteEnts[it].entry.type === TypeEnum.DIRECTORY)
            ) {
                this.buildTree(subIndex);
            }
        }
    }
}

export function burn(entries: Entry[]): Uint8Array {
    return new Uint8Array(new LiteBurner(entries).array);
}