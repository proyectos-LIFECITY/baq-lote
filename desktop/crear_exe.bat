@echo off
REM Genera dist\BAQ_Lote.exe (Windows) - requiere Python 3.9+ en el PATH
cd /d "%~dp0"
python -m pip install --upgrade requests pyinstaller
python -m PyInstaller --noconfirm --onefile --windowed --name BAQ_Lote ^
  --hidden-import norma_baq ^
  --add-data "norma_edificabilidad_baq.json;." ^
  baq_lote.py
copy /y norma_edificabilidad_baq.json dist\ >nul
echo.
echo Ejecutable listo en: dist\BAQ_Lote.exe
echo (norma_edificabilidad_baq.json junto al .exe se puede editar sin recompilar)
pause
