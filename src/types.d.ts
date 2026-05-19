declare module "@tgwf/co2" {
  export class co2 {
    constructor(options?: { model?: string; version?: number });
    perByte(bytes: number, green?: boolean): number;
  }
}
