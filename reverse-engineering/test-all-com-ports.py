#!/usr/bin/env python3
import serial
import serial.tools.list_ports
import time
import sys

def test_port(port_name, baudrates=[9600, 19200, 38400, 115200]):
    """Test a single COM port with different baudrates."""
    for baud in baudrates:
        try:
            port = serial.Serial(port_name, baud, timeout=2)
            print(f"\n[{port_name} @ {baud} baud] Conectado. Lendo por 5s...")

            start_time = time.time()
            data_received = b''

            while time.time() - start_time < 5:
                try:
                    chunk = port.read(1024)
                    if chunk:
                        data_received += chunk
                        print(f"  Recebeu {len(chunk)} bytes")
                except:
                    pass

            if data_received:
                print(f"  TOTAL: {len(data_received)} bytes")
                print(f"  Primeiros 64 bytes (hex): {data_received[:64].hex()}")
                print(f"  Primeiros 64 bytes (ascii): {repr(data_received[:64])}")
            else:
                print(f"  Nenhum dado recebido")

            port.close()
        except Exception as e:
            print(f"[{port_name} @ {baud} baud] Erro: {e}")

def main():
    ports = serial.tools.list_ports.comports()

    if not ports:
        print("Nenhuma porta COM encontrada!")
        return

    print(f"Encontradas {len(ports)} porta(s):")
    for p in ports:
        print(f"  {p.device}: {p.description}")

    print("\n" + "="*60)
    print("TESTANDO TODAS AS PORTAS...")
    print("="*60)

    for p in ports:
        test_port(p.device)

    print("\n" + "="*60)
    print("TESTES COMPLETOS")
    print("="*60)

if __name__ == '__main__':
    main()
