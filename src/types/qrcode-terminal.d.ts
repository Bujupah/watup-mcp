declare module 'qrcode-terminal' {
  interface Options {
    small?: boolean;
  }
  const qrcodeTerminal: {
    generate(text: string, opts?: Options, cb?: (output: string) => void): void;
    setErrorLevel(level: 'L' | 'M' | 'Q' | 'H'): void;
  };
  export default qrcodeTerminal;
}
