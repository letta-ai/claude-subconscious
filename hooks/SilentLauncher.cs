using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Silent launcher: PseudoConsole + CREATE_NO_WINDOW (no STARTF_USESTDHANDLES)
// Stdin/stdout delivered via temp files + --require preload.
// This is the ONLY combination that eliminates Windows Terminal popup on Win11 26300.
class SilentLauncher
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(
        string lpApplicationName, StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe,
        ref SECURITY_ATTRIBUTES lpPipeAttributes, uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToRead,
        out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite,
        out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int nStdHandle);

    // ---- PseudoConsole ----
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    static extern void ClosePseudoConsole(IntPtr hPC);

    // ---- Thread Attribute List ----
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount,
        int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true, EntryPoint = "UpdateProcThreadAttribute")]
    static extern bool UpdateProcThreadAttributeList(IntPtr lpAttributeList, uint dwFlags,
        IntPtr Attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    // ---- Environment ----
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr GetEnvironmentStrings();

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool FreeEnvironmentStrings(IntPtr lpszEnvironmentBlock);

    [DllImport("kernel32.dll")]
    static extern uint GetLastError();

    [StructLayout(LayoutKind.Sequential)]
    struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES
    {
        public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
        public uint dwFlags; public ushort wShowWindow; public ushort cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId;
    }

    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint INFINITE = 0xFFFFFFFF;
    const int STD_OUTPUT_HANDLE = -11;
    const int STD_INPUT_HANDLE = -10;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = (IntPtr)0x00020016;

    // Build a Unicode environment block with extra vars prepended
    static IntPtr BuildEnvironmentBlock(string extraVars)
    {
        // Get current environment
        IntPtr envPtr = GetEnvironmentStrings();
        // Parse into string: each var is null-terminated, block ends with double null
        var sb = new StringBuilder();
        sb.Append(extraVars); // already formatted as "KEY=VALUE\0KEY=VALUE\0"
        int offset = 0;
        while (true)
        {
            string entry = Marshal.PtrToStringUni(envPtr + offset * 2);
            if (string.IsNullOrEmpty(entry)) break;
            sb.Append(entry);
            sb.Append('\0');
            offset += entry.Length + 1;
        }
        FreeEnvironmentStrings(envPtr);
        sb.Append('\0'); // double null terminator
        string block = sb.ToString();
        IntPtr blockPtr = Marshal.StringToHGlobalUni(block);
        return blockPtr;
    }

    static int Main(string[] args)
    {
        if (args.Length == 0) return 1;

        // Read all stdin from parent into memory
        IntPtr parentStdin = GetStdHandle(STD_INPUT_HANDLE);
        var allData = new MemoryStream();
        byte[] readBuf = new byte[4096];
        uint bytesRead;
        while (ReadFile(parentStdin, readBuf, (uint)readBuf.Length, out bytesRead, IntPtr.Zero) && bytesRead > 0)
        {
            allData.Write(readBuf, 0, (int)bytesRead);
        }
        byte[] stdinData = allData.ToArray();

        // Create temp files for stdin and stdout
        string tempDir = Path.GetTempPath();
        string stdinFile = Path.Combine(tempDir, "sl-stdin-" + System.Diagnostics.Process.GetCurrentProcess().Id + ".tmp");
        string stdoutFile = Path.Combine(tempDir, "sl-stdout-" + System.Diagnostics.Process.GetCurrentProcess().Id + ".tmp");
        File.WriteAllBytes(stdinFile, stdinData);
        File.WriteAllText(stdoutFile, ""); // create empty

        // Find preload path (same directory as this exe)
        string exeDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string preloadPath = Path.Combine(exeDir, "stdio-preload.cjs");

        // Build command line: node --require preload --import tsx/esm script.ts
        // Use tsx as a loader (--import) instead of tsx CLI (which spawns a child process).
        // This runs everything in ONE process so --require preload captures script output.
        var cmdLine = new StringBuilder();
        cmdLine.Append(args[0]); // "node"
        cmdLine.Append(" --require \"");
        cmdLine.Append(preloadPath);
        cmdLine.Append('"');

        // Find tsx ESM loader: derive from tsx CLI path (args[1])
        // args[1] is like ".../node_modules/tsx/dist/cli.mjs"
        // We need ".../node_modules/tsx/dist/esm/index.mjs" as file:// URL
        string tsxCliPath = args[1];
        string tsxDir = Path.GetDirectoryName(tsxCliPath); // .../tsx/dist
        string tsxEsmPath = Path.Combine(tsxDir, "esm", "index.mjs");
        // Convert to file:// URL (forward slashes, no quotes needed)
        string tsxEsmUrl = "file:///" + tsxEsmPath.Replace('\\', '/');
        cmdLine.Append(" --import ");
        cmdLine.Append(tsxEsmUrl);

        // Add the script path (args[2+])
        for (int i = 2; i < args.Length; i++)
        {
            cmdLine.Append(' ');
            string arg = args[i];
            if (arg.Contains(" ") || arg.Contains("\""))
            {
                cmdLine.Append('"');
                cmdLine.Append(arg.Replace("\"", "\\\""));
                cmdLine.Append('"');
            }
            else cmdLine.Append(arg);
        }

        // Build environment block with SL_STDIN_FILE and SL_STDOUT_FILE
        string extraEnv = "SL_STDIN_FILE=" + stdinFile + "\0" + "SL_STDOUT_FILE=" + stdoutFile + "\0";
        IntPtr envBlock = BuildEnvironmentBlock(extraEnv);

        // Create pipes for PseudoConsole (required by API)
        var saNonInherit = new SECURITY_ATTRIBUTES();
        saNonInherit.nLength = Marshal.SizeOf(saNonInherit);
        saNonInherit.bInheritHandle = false;
        saNonInherit.lpSecurityDescriptor = IntPtr.Zero;

        IntPtr ptyInR, ptyInW, ptyOutR, ptyOutW;
        CreatePipe(out ptyInR, out ptyInW, ref saNonInherit, 0);
        CreatePipe(out ptyOutR, out ptyOutW, ref saNonInherit, 0);

        IntPtr hPC;
        var ptySize = new COORD { X = 120, Y = 30 };
        int hr = CreatePseudoConsole(ptySize, ptyInR, ptyOutW, 0, out hPC);
        if (hr != 0)
        {
            Marshal.FreeHGlobal(envBlock);
            return 1;
        }
        CloseHandle(ptyInR);
        CloseHandle(ptyOutW);

        // Set up thread attribute list with pseudoconsole
        IntPtr attrSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
        IntPtr attrList = Marshal.AllocHGlobal((int)attrSize);
        InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize);

        IntPtr hPCBoxed = Marshal.AllocHGlobal(IntPtr.Size);
        Marshal.WriteIntPtr(hPCBoxed, hPC);
        UpdateProcThreadAttributeList(attrList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            hPCBoxed, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero);

        // PseudoConsole + CREATE_NO_WINDOW: no flash, no pipe I/O
        // Stdin/stdout via temp files + preload
        var si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(si);
        // NO STARTF_USESTDHANDLES — that's what causes flashes
        si.lpAttributeList = attrList;

        uint flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT;

        PROCESS_INFORMATION pi;
        bool created = CreateProcess(null, cmdLine, IntPtr.Zero, IntPtr.Zero,
            false, flags,
            envBlock, null, ref si, out pi);

        Marshal.FreeHGlobal(envBlock);

        if (!created)
        {
            DeleteProcThreadAttributeList(attrList);
            Marshal.FreeHGlobal(attrList);
            Marshal.FreeHGlobal(hPCBoxed);
            ClosePseudoConsole(hPC);
            return 1;
        }
        CloseHandle(pi.hThread);

        // Drain PTY output (required to prevent deadlock, but output is empty with CREATE_NO_WINDOW)
        var ptyDrainThread = new Thread(() => {
            byte[] buf = new byte[4096]; uint n;
            while (ReadFile(ptyOutR, buf, (uint)buf.Length, out n, IntPtr.Zero) && n > 0) {}
        });
        ptyDrainThread.IsBackground = true;
        ptyDrainThread.Start();

        // Wait for child to exit
        WaitForSingleObject(pi.hProcess, INFINITE);
        uint exitCode;
        GetExitCodeProcess(pi.hProcess, out exitCode);
        // Read captured stdout and relay to parent
        IntPtr parentStdout = GetStdHandle(STD_OUTPUT_HANDLE);
        try
        {
            byte[] stdoutData = File.ReadAllBytes(stdoutFile);
            if (stdoutData.Length > 0)
            {
                uint written;
                WriteFile(parentStdout, stdoutData, (uint)stdoutData.Length, out written, IntPtr.Zero);
            }
        }
        catch { }

        // Cleanup
        ClosePseudoConsole(hPC);
        ptyDrainThread.Join(2000);
        CloseHandle(ptyOutR);
        CloseHandle(ptyInW);
        CloseHandle(pi.hProcess);
        DeleteProcThreadAttributeList(attrList);
        Marshal.FreeHGlobal(attrList);
        Marshal.FreeHGlobal(hPCBoxed);

        // Clean up temp files
        try { File.Delete(stdinFile); } catch { }
        try { File.Delete(stdoutFile); } catch { }

        return (int)exitCode;
    }
}
