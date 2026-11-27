package br.com.conquistapark.comandas;

import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.os.Bundle;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * NFC do próprio tablet (Comandas, 055). Com o app aberto, toda pulseira encostada no tablet vira
 * o evento "pulseira" com o UID em hexadecimal, na ordem em que o Android entrega
 * (Tag.getId()). A conversão pro número do leitor USB (10 dígitos) é feita no JavaScript
 * (src/nfc.ts), onde dá pra ajustar a ordem dos bytes sem gerar outro APK.
 *
 * Usa o "reader mode": enquanto o app está na frente, o Android não abre outro app nem toca o
 * som dele ao ler a pulseira.
 */
@CapacitorPlugin(name = "LeitorNfc")
public class LeitorNfcPlugin extends Plugin {

    private NfcAdapter adaptador;

    @Override
    public void load() {
        adaptador = NfcAdapter.getDefaultAdapter(getContext());
    }

    /** { existe: o tablet tem NFC, ligado: o NFC está ligado nas configurações do Android } */
    @PluginMethod
    public void estado(PluginCall call) {
        JSObject r = new JSObject();
        r.put("existe", adaptador != null);
        r.put("ligado", adaptador != null && adaptador.isEnabled());
        call.resolve(r);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        ligar();
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (adaptador != null) {
            try { adaptador.disableReaderMode(getActivity()); } catch (Exception ignorado) { }
        }
    }

    private void ligar() {
        if (adaptador == null || !adaptador.isEnabled()) return;
        int tipos = NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_NFC_B
                | NfcAdapter.FLAG_READER_NFC_F | NfcAdapter.FLAG_READER_NFC_V
                | NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK | NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS;
        Bundle opcoes = new Bundle();
        // espera 250 ms antes de dar a pulseira como "afastada": evita a mesma leitura repetida
        opcoes.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250);
        try {
            adaptador.enableReaderMode(getActivity(), this::lida, tipos, opcoes);
        } catch (Exception ignorado) { }
    }

    private void lida(Tag tag) {
        byte[] id = tag.getId();
        if (id == null || id.length == 0) return;
        StringBuilder hex = new StringBuilder();
        for (byte b : id) hex.append(String.format("%02X", b));
        JSObject dado = new JSObject();
        dado.put("hex", hex.toString());
        notifyListeners("pulseira", dado);
    }
}
