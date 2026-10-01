from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_dynamic_libs, collect_submodules


datas = collect_data_files("dateparser")
binaries = collect_dynamic_libs("ctranslate2")
hiddenimports = collect_submodules("config") + collect_submodules("notetaker")

fw_datas, fw_binaries, fw_hidden = collect_all("faster_whisper")
datas += fw_datas
binaries += fw_binaries
hiddenimports += fw_hidden

sherpa_datas, sherpa_binaries, sherpa_hidden = collect_all("sherpa_onnx")
datas += sherpa_datas
binaries += sherpa_binaries
hiddenimports += sherpa_hidden

analysis = Analysis(
    ["launcher.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    noarchive=False,
)
pyz = PYZ(analysis.pure)
exe = EXE(
    pyz,
    analysis.scripts,
    [],
    name="notetaker-backend",
    console=False,
    exclude_binaries=True,
)
collect = COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    name="notetaker-backend",
)
