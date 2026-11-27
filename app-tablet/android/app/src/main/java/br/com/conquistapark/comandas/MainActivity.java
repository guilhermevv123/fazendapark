package br.com.conquistapark.comandas;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // o NFC do tablet (leitura de pulseira); registrado ANTES do super, como pede o Capacitor
        registerPlugin(LeitorNfcPlugin.class);
        super.onCreate(savedInstanceState);
        // a tela não apaga no meio do atendimento
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
