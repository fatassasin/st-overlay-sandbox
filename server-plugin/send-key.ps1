param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9]+$')]
    [string]$Code
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class OverlayKeySender
{
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion data; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT
    {
        public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT
    {
        public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);

    static readonly Dictionary<string, ushort> Keys = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
    {
        { "AltRight", 0xA5 }, { "AltLeft", 0xA4 }, { "ControlRight", 0xA3 }, { "ControlLeft", 0xA2 },
        { "ShiftRight", 0xA1 }, { "ShiftLeft", 0xA0 }, { "Enter", 0x0D }, { "Space", 0x20 },
        { "Escape", 0x1B }, { "Tab", 0x09 }, { "Backspace", 0x08 }, { "Delete", 0x2E },
        { "Home", 0x24 }, { "End", 0x23 }, { "PageUp", 0x21 }, { "PageDown", 0x22 },
        { "ArrowLeft", 0x25 }, { "ArrowUp", 0x26 }, { "ArrowRight", 0x27 }, { "ArrowDown", 0x28 }
    };

    public static void Press(string code)
    {
        ushort vk;
        if (!Keys.TryGetValue(code, out vk))
        {
            if (code.StartsWith("Key") && code.Length == 4) vk = code[3];
            else if (code.StartsWith("Digit") && code.Length == 6) vk = code[5];
            else if (code.StartsWith("F"))
            {
                int f;
                if (!int.TryParse(code.Substring(1), out f) || f < 1 || f > 24) throw new ArgumentException("Unsupported key: " + code);
                vk = (ushort)(0x6F + f);
            }
            else throw new ArgumentException("Unsupported key: " + code);
        }

        uint flags = code.EndsWith("Right") || code == "Delete" || code.StartsWith("Arrow") ||
                     code == "Home" || code == "End" || code == "PageUp" || code == "PageDown" ? 1u : 0u;
        ushort scan = (ushort)MapVirtualKey(vk, 0);
        var inputs = new INPUT[2];
        inputs[0].type = 1; inputs[0].data.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
        inputs[1].type = 1; inputs[1].data.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags | 2u };
        if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
[OverlayKeySender]::Press($Code)
