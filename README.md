# cah-hud

`cah-hud` cria uma sobreposição modular de feiticeiro (interface em **português**), composta por widgets independentes e livremente posicionáveis, que só aparecem **depois de o jogador concluir o `hmp-spawn`**. O recurso escuta o evento de ciclo de vida `hmp:spawn:complete` do plugin de spawn, portanto o HUD só é exibido depois de o personagem escolher um destino e o teletransporte transmitido pelo jogo ser confirmado. O HUD volta a ser ocultado quando o personagem é descarregado (`hmp:character:unloading`) ou quando a sessão termina.

Enquanto o HUD está visível, ele **oculta o HUD nativo do jogo** através de `Hud.hideGroup` para todos os grupos de HUD informados pelo jogo, exceto o mapa/minimapa (configurável através de `gameHud.keepGroups`). Dessa forma, a sobreposição personalizada substitui a barra de feitiços, vida, rastreador de missões e outros elementos nativos sem alterar as configurações pessoais do jogador. Todos os grupos ocultados são restaurados quando o HUD é ocultado ou quando ocorre uma desconexão.

## O que é apresentado

O HUD é composto por seis widgets, cada um com a sua própria posição na tela (em percentagem da área do ecrã), com uma disposição padrão distribuída ao redor do mapa nativo:

- **Galeões + Bolsa** (canto superior esquerdo) — galeões nativos contabilizados através de `hmp-inventory` (`native:galleons` por padrão), juntamente com os espaços utilizados / espaços totais e o peso utilizado / peso máximo da visão unificada do `hmp-inventory`. A informação é apresentada como uma barra, podendo representar espaços ou peso, conforme a configuração.

- **Relógio + Hora + Estação** (centro superior) — informações em tempo real provenientes do estado do ambiente do `hmp-world`, com os nomes do clima e das estações traduzidos para português.

- **Ano escolar + luz de aprovação** (canto superior direito) — derivado do nível do feiticeiro através de faixas configuráveis (1–5 → Ano 1 … 31+ → Ano 7 por padrão), com possibilidade de substituição individual por personagem. Ao lado do ano existe um ponto luminoso que reproduz o estado de aprovação do personagem: verde quando o teste de final de ano foi aprovado e vermelho enquanto ainda faltarem requisitos ("Teste para o Ano 5 · falta: Feitiços 2/4, …").

- **Horário das aulas** (direita) — apresenta o horário diário com base no relógio do jogo. Enquanto uma aula está a decorrer, o widget apresenta o indicador **Em aula**, com "até HH:MM" e os minutos restantes. Caso contrário, apresenta **Próxima**, com a hora de início e uma contagem regressiva. Se uma aula tiver coordenadas `x/y/z`, a sala da aula atual ou seguinte também é publicada como um marcador no mapa através do `hmp-blips`, com etiquetas como `Agora: Herbologia - Estufas` / `Próxima: Poções 11:00 - Sala de Poções`, permitindo ao jogador saber onde será a próxima aula.

- **Vida** (parte inferior, afastada do mapa) — o cliente lê o próprio `LocalPlayer.stateInfo` do jogo (`getHealth` / `getMaxHealth` / `isDead`). Uma leitura de vida válida do jogo tem sempre prioridade, o valor máximo nativo ajusta a barra e `isDead` fixa a vida em zero. O valor `player.health` do servidor e os eventos `playerDied` / `playerDowned` (estado `healthForced`) servem apenas como alternativa quando a leitura do jogo não está disponível. Um estado de morte é automaticamente corrigido se o jogo voltar a indicar vida ou após 90 segundos sem um evento `playerDownedEnd`.

- **Nível de Feiticeiro + XP** (canto inferior direito) — o nível e o XP são provenientes do perfil de `hmp-progression`. A barra utiliza `Progression.getLevelBounds` nativo do jogo no cliente para preencher suavemente e apresenta **máx** no nível final.

- **Feitiços** (canto inferior direito, abaixo da barra de XP) — apresenta os quatro feitiços equipados na barra rápida do jogo, obtidos no cliente através de `Spells.loadout()` e atualizados imediatamente através do evento `spellAssignment` do jogo. Cada feitiço é representado como uma chama de vela criada exclusivamente através de pontos de brilho aditivo e **a cor pertence ao próprio feitiço**: cores definidas para feitiços conhecidos (Incendio = laranja de fogo, Glacius = azul de gelo, …) e, nos restantes casos, um hash estável do nome do feitiço. O mesmo feitiço terá sempre a mesma cor em qualquer espaço. As chamas recebem pequenas variações e faíscas aleatórias; espaços vazios ficam como brasas ténues e o widget só aparece quando pelo menos um espaço contém um feitiço. Tudo é renderizado num único canvas com partículas reutilizadas, sprites de tonalidade pré-renderizados e limite de 30 FPS, parando completamente quando o HUD ou o separador está oculto.

Cada widget só é renderizado quando a respetiva fonte de dados está disponível. Por exemplo, se `hmp-world` for removido, o relógio, o clima e o horário das aulas também desaparecem. Os widgets ocultos aparecem como espaços reservados esbatidos enquanto o editor de layout estiver aberto.

- **Alternância do inventário com I** — pressionar **I** abre o ecrã do `hmp-inventory` e pressionar **I** novamente fecha-o. A tecla pertence ao `hmp-inventory` (`ui.key` em `data/hmp-inventory.json`, registada através da arbitragem de atalhos do `hmp-lib`); este recurso nunca a registra, pelo que nunca há duplicação no mesmo edge. Enquanto o ecrã está aberto o HUD passa para o lado e volta quando o ecrã fecha (eventos `hmp-inventory:open` / `hmp-inventory:close`). A página de inventário fecha-se com a própria tecla de alternância — repassada ao foco pelo cliente — ou com ESC.
- **Segurar TAB esconde o HUD (roda de itens)** — a roda de itens nativa do jogo abre-se ao segurar TAB; enquanto essa tecla (`keybinds.hudHoldKey`, TAB por padrão) estiver premida, os widgets do HUD passam para o lado e voltam no instante em que a tecla é largada. Como uma página focada engole os eventos das teclas, o largar é apanhado de três formas: o edge `up` da tecla quando a camada de jogo o vê, uma sondagem do estado físico da tecla (80 ms) enquanto a premissão durar, e um prazo de 8 s que nunca deixa o HUD escondido por conta própria. A suspensão empilha razões (mapa Floo Flames, ecrã do inventário, premissão da tecla), por isso várias podem estar ativas ao mesmo tempo sem se atropelarem. Enquanto o HUD está de lado, os marcadores de nome também desaparecem. Uma cadeia vazia (`"hudHoldKey": ""`) desliga este comportamento.

- **Etiquetas de nome (nametags)** — o marcador acima da cabeça de cada jogador é desenhado por uma vista web transparente própria (`dist/nametags.html`) em vez da camada de nametags do motor (que é desligada enquanto a sobreposição corre e reposta quando o recurso para): nomes de personagem do `hmp-core` (nunca o nickname do Steam/Discord), brasão da casa, barra de vida tingida pela casa, badge de voz próprio/alheio e marcas por observador (ex.: infratores do toque de recolher, via `setNametagMark`). A sobreposição é **sempre por cima do jogador**: a oclusão está desligada por padrão (`nametags.occlusion: true` a volta a ligar, com um orçamento de 6 line-traces por frame) e o alcance padrão é 12000 (~120 m), com os marcadores a 100% de opacidade até 90% do alcance; `nametags.range`, `nametags.maxMarkers` (32), `nametags.height`, `nametags.fontScale`, `nametags.tickMs` e as correções de projeção (`fov`, `flipYaw`, `flipPitch`) são configuráveis em `data/hmp-hud.json`.

- **Ocultação do HUD nativo do jogo** — enquanto o HUD estiver visível, todos os grupos de HUD informados por `Hud.groups()` do Framework são ocultados através de `Hud.hideGroup`. As escolhas do jogador em **Definições** não são alteradas e tudo é restaurado quando o HUD é ocultado ou quando ocorre uma desconexão. Os grupos cujo nome contenha uma entrada de `gameHud.keepGroups` (por padrão, `["map"]`) permanecem visíveis. Pode ser desativado com `gameHud.enabled: false`.

- **Editor de layout `/menu`** — todos os widgets podem ser posicionados livremente. `/menu` coloca o HUD em foco e obtém um controlo de entrada para permitir arrastar os widgets. **Guardar** grava o layout através dos metadados `cah-hud:layout` do `hmp-core`, com `localStorage` como alternativa. **Concluir** ou ESC sai do editor e **Exportar/Importar** permite partilhar layouts através de JSON. Os widgets ocultos aparecem como espaços reservados esbatidos durante a edição. Pode ser desativado com `menu.enabled: false` ou o comando pode ser alterado através de `menu.command`.

## O editor de layout `/menu`

Escrever **`/menu`** (ou `/hud menu`) abre um editor de layout em ecrã inteiro:

- os controlos do jogo são bloqueados através de um controlo de entrada do `hmp-lib` e a vista do editor recebe o foco do teclado e do rato;
- todos os widgets podem ser **arrastados** para qualquer posição no ecrã. As posições ajustam-se a uma grelha de 0,5% e são limitadas para impedir que os widgets saiam da área visível;
- **Guardar** (canto superior direito) grava o layout por conta através dos metadados `hmp-core` (`cah-hud:layout`) e também no `localStorage` da página;
- **Exportar** apresenta o layout como JSON formatado, com um botão para copiar. **Importar** aceita um JSON partilhado, aplica-o, guarda-o e apresenta uma notificação;
- **Repor** restaura a disposição padrão, enquanto **Concluir** ou **F8** sai do editor e devolve o controlo ao jogo sem ocultar o HUD. ESC não faz nada enquanto o editor estiver aberto e F9 mantém o seu significado original no mod. Uma pequena indicação "F8 — sair do editor" aparece na parte inferior do ecrã.

Enquanto o editor estiver aberto, os widgets cuja fonte de dados não esteja disponível continuam visíveis, embora esbatidos, para que possam ser posicionados.

## Testes de final de ano (a luz verde)

Cada ano escolar termina com um teste — **`/teste`** por padrão (`year.tests.command`). O teste lê os **níveis das disciplinas** do jogador e compara-os com os requisitos necessários para o próximo ano escolar. Se o jogador passar, o ano avança imediatamente e o ponto de aprovação fica verde. Se falhar, a resposta indica exatamente quais os requisitos em falta ("Falta: Nível 12/20, Feitiços 2/4, Poções 1/4").

- **O requisito oculto de nível de feiticeiro**: existem cinco níveis por ano escolar — o Ano 2 exige nível 5, o Ano 3 exige nível 10, …, e o Ano 5 exige nível 20 (`(targetYear - 1) * 5`). `minLevel` pode substituir esse valor para determinado ano.
- **Níveis das disciplinas** são talentos do `hmp-progression` com os nomes `<talentPrefix><classKey>` — por padrão, `class-charms`, `class-potions`, `class-defence`, `class-herbology`. Estes valores podem ser concedidos pelo sistema de aulas através de `progression.talents.grant(...)`. O prefixo é configurável através de `year.tests.talentPrefix`.
- **A luz de aprovação encontra-se no widget do ano**: o ponto ao lado de "Ano X" fica verde quando o jogador é aprovado e vermelho enquanto o teste estiver pendente.
- O widget do ano reproduz o estado do ponto luminoso e a linha de estado apresenta os requisitos em falta, incluindo o nível de feiticeiro.
- Os requisitos são configurados individualmente para cada ano de destino em `year.tests.requirements`. Um ano sem requisitos configurados é automaticamente aprovado. `year.tests.enabled: false` desativa todo o sistema.

## O marcador acima dos jogadores (nametags)

O marcador que flutua acima de cada jogador — **nome do personagem, barra de vida e estado de voz** — é desenhado por uma webview transparente dedicada (`dist/nametags.html`), não pela camada de nametags do motor. A camada nativa só consegue desenhar texto com a fonte do motor, pelo que não suporta imagens, tipo de letra próprio nem uma barra de vida redesenhada — e mostrava o nickname da plataforma (Steam/Discord) em vez do nome de roleplay. A sobreposição substitui tudo isso:

- **Nome do personagem** — vindo do `hmp-core` (`characters.active`), nunca o nickname do Steam/Discord. Sem personagem ativo, cai para o nickname em vez de desenhar um cartão vazio;
- **Crest da casa** — a imagem do crest (`dist/crests/*.png`) ao lado do nome, com a barra de vida e o nome tingidos com a cor da casa;
- **Barra de vida** — lida pela cadeia de vitals do servidor (export `vitals` do `hmp-pvp`, depois `Pvp.getVitals(id)` nativo, e `player.health` só como último recurso — a mesma cadeia que o `hmp-death` usa, porque esta build pode nem expor `player.health`); o máximo vem da própria vista de vitals. No marcador próprio a vida é lida diretamente do jogo (`LocalPlayer.stateInfo`), como no widget do HUD. Fica vermelha abaixo de 25%;
- **Estado de voz** — um emblema de microfone: verde com voz ativa, branco pulsante enquanto fala, vermelho com voz desligada/sem micro. O estado próprio é lido localmente (global `Voice`); o dos outros chega pelo servidor (`playerVoiceStart` / `playerVoiceStop`);
- **Marcas por observador** — outros recursos podem afixar glifos através do export `setNametagMark(viewer, targetId, marca, ativo)`; o `hmp-schedule` usa-o para o ✖ vermelho dos infratores do recolher (visível apenas aos Professores).

Os nametags nativos do motor ficam **desligados** enquanto a sobreposição corre (`Nametags.setVisible(false)`) e são repostos quando o recurso para. Os marcadores projetam a posição de cada jogador para o ecrã (`Camera.capture()` + `Web.getScreenSize()`, com recurso a `LocalPlayer.getControlRotation()` + posição do jogador quando a câmara não responde), interpolam entre amostras do servidor e esbatem-se com a distância (opacidade plena até 90% do alcance, nunca abaixo de 30 m). A oclusão por linha de visão (`World.lineTrace` no canal `camera`) existe mas vem desligada por omissão.

O marcador **próprio** tem tratamento especial, porque a câmara em terceira pessoa anda colada à cabeça: ancora um pouco mais abaixo (`selfHeight`, por defeito 145 cm) e, em vez de ser cortado quando sai do enquadramento, é preso ao ecrã — fica sempre legível para nós próprios. Só é desenhado com a câmara longe do corpo (terceira pessoa); em primeira pessoa seria apenas um cartão por cima da mira.

Configuração em `data/hmp-hud.json`, bloco `"nametags"`:

| Chave | Padrão | Significado |
|---|---|---|
| `enabled` | `true` | Liga/desliga toda a sobreposição (desligada, os nametags nativos do motor voltam). |
| `range` | `12000` | Alcance máximo dos marcadores, em centímetros (120 m). O piso é 3000 (30 m): qualquer jogador próximo está nomeado a essa distância. |
| `tickMs` | `150` | Frequência com que o cliente pede o roster ao servidor (posições/vida/voz). |
| `showSelf` | `true` | Desenha o marcador do próprio jogador (com o emblema de voz local). |
| `occlusion` | `false` | Esconder marcadores atrás de paredes/objetos — desligado por omissão: uma parede não deve apagar o nome. |
| `height` | `185` | Altura do cartão acima do **chão**, em centímetros. O cartão é ancorado ao terreno por baixo de cada jogador (line trace para baixo, em cache e renovado com o movimento), por isso a altura da origem do personagem — bacia ou pés, conforme a compilação — nunca empurra o cartão para longe da cabeça. Jogadores a voar (vassouras) usam um desvio relativo à origem até aterrarem. |
| `selfHeight` | `185` | Altura do cartão do próprio jogador acima do chão (por omissão igual a `height`); pode baixar-se para aproximar o cartão da cabeça na câmara em terceira pessoa. O cartão próprio é preso ao ecrã e só é desenhado com a câmara longe do corpo. |
| `maxMarkers` | `32` | Número máximo de jogadores desenhados (os mais próximos). |
| `fontScale` | `1.0` | Escala do texto do cartão (família **Cinzel**, fornecida em `dist/fonts/`). |
| `fov` | `0` | Sobrepõe o FOV horizontal da câmara na projeção (0 = usar o valor do motor; um FOV abaixo de 10 é tratado como radianos e convertido). |
| `flipYaw` / `flipPitch` | `false` | Calibração dos eixos da projeção, caso uma compilação do motor inverta a rotação. |

## Indicador de voz

O emblema de voz vive agora no marcador acima da cabeça (ver secção anterior). O comportamento é o mesmo que o antigo ponto luminoso:

- **verde** quando o chat de voz está ativo e a funcionar;
- **branco** quando o jogador está efetivamente a falar;
- **vermelho** quando a voz não está a funcionar — desligada/silenciada ou sem microfone a captar áudio.

O estado próprio é obtido da variável global `Voice` a cada frame e atualizado através dos eventos `voiceStart` / `voiceStop`.

**`/voz`** permite consultar e alterar estas definições através do chat:

- `/voz` — apresenta o estado atual, microfone, tecla de push-to-talk, modo de transmissão e nível do microfone;
- `/voz b` (ou qualquer nome de tecla) — altera a tecla de push-to-talk;
- `/voz on` / `/voz off` — ativa ou desativa o chat de voz;
- `/voz modo` — alterna entre push-to-talk e ativação por voz.

- **Menus do jogo desativados**: `Game.setPauseMenuEnabled(false)` mantém o Guia de Campo do jogo fechado enquanto o recurso estiver em execução. **ESC** e os atalhos de páginas (**N/Y/U/I**, mapa, inventário, talentos, definições, etc.) não têm efeito. Os bloqueios opcionais `toolWheel` (Tab) e `actionScreen` (T) abrangem as duas teclas utilizadas pelo HUD. `mode: "pages"` desativa apenas páginas individuais do Guia de Campo. Os bloqueios são libertados automaticamente ao parar/recarregar/desconectar.

## Chat sem HUD nativo

A sobreposição de chat nativa fica **oculta** (`Chat.setUIVisible(false)`) e o chat passa a ser renderizado **dentro da webview do HUD**, mantendo o mesmo visual de pergaminho e dourado.

O chat é um **widget arrastável**, como os restantes: pode ser movido através de `/menu` e a sua posição é guardada juntamente com o layout.

### Canais

Cada linha é classificada e identificada, e a linha de separadores (**Tudo / Sistema / Local / OOC**) filtra o registo:

- **Sistema** — linhas provenientes do servidor sem autor, como respostas de `[hud]`, `[teste]`, `[voz]`, etc.;
- **Local** — chat normal dos jogadores, dentro da personagem;
- **OOC** — mensagens fora da personagem: texto envolvido por `(( ))` ou iniciado por `[OOC]`. Por exemplo, `(( vou ficar ausente` é colocado no canal OOC.

As mensagens recebidas chegam através do evento reservado `chatMessage` e aparecem no canto inferior esquerdo, acima do mapa. As mensagens antigas desaparecem após aproximadamente 9 segundos.

**T** (configurável através de `chat.openKey`) abre a caixa de entrada do HUD. O texto é enviado através de `Chat.send`, portanto os **comandos com barra continuam a funcionar** (`/hud`, `/teste`, `/voz`, `/menu`, etc.).

**Enter** envia, **ESC** fecha e o chat nativo volta a aparecer ao desconectar ou se `chat.enabled: false`.

## Instalação

O recurso é distribuído já compilado (`dist/server.js`, `dist/client.js`, `dist/hud.html`) e declara `hmp-lib`, `hmp-core`, `hmp-spawn`, `hmp-inventory`, `hmp-progression`, `hmp-world` e `hmp-blips` como dependências.

Coloque a pasta `cah-hud` dentro de `resources/`, adicione-a à lista de mods do servidor caso a configuração enumere explicitamente os recursos e reinicie o servidor. Opcionalmente, crie `data/cah-hud.json`.

## Configuração

Ficheiro opcional `data/cah-hud.json`; substituição através do ambiente: `HMP_HUD_CONFIG`.

```json
{
  "updateIntervalMs": 1000,
  "inventoryRefreshMs": 10000,
  "money": { "enabled": true, "item": "native:galleons", "label": "Galeões" },
  "inventory": { "enabled": true, "metric": "slots" },
  "health": { "enabled": true, "max": 100 },
  "xp": { "enabled": true },
  "gameHud": { "enabled": true, "keepGroups": ["map"] },
  "menu": { "enabled": true, "command": "menu" },
  "year": {
    "mode": "school",
    "metadataKey": "cah-hud:year",
    "tests": {
      "enabled": true,
      "command": "teste",
      "talentPrefix": "class-",
      "requirements": [
        { "targetYear": 2, "classes": { "charms": 1, "potions": 1, "defence": 1, "herbology": 1 } },
        { "targetYear": 5, "classes": { "charms": 4, "potions": 4, "defence": 4, "herbology": 4 } }
      ]
    },
    "bands": [
      { "maxLevel": 5, "year": 1 },
      { "maxLevel": 10, "year": 2 },
      { "maxLevel": 15, "year": 3 },
      { "maxLevel": 20, "year": 4 },
      { "maxLevel": 25, "year": 5 },
      { "maxLevel": 30, "year": 6 },
      { "maxLevel": 40, "year": 7 }
    ]
  },
  "classes": {
    "enabled": true,
    "showBlip": true,
    "items": [
      {
        "key": "charms",
        "subject": "Feitiços",
        "teacher": "Professor Flitwick",
        "location": "Sala de Feitiços",
        "start": "09:00",
        "end": "10:00"
      },
      {
        "key": "herbology",
        "subject": "Herbologia",
        "location": "Estufas",
        "start": "16:00",
        "end": "17:00",
        "x": 366784,
        "y": -461527,
        "z": -82610,
        "areaId": "Overland"
      }
    ]
  }
}
```

## Notas

- `updateIntervalMs` — intervalo que atualiza vida, dinheiro, relógio, clima e horário das aulas (250 ms – 60 s). O inventário também é atualizado através de `hmp:inventory:changed` e de `inventoryRefreshMs`.
- `gameHud.enabled` — controla a ocultação do HUD nativo através de `Hud.hideGroup`.
- `gameHud.keepGroups` — lista de substrings em minúsculas que permanecem visíveis. O padrão `["map"]` mantém o mapa.
- `menu.enabled` / `menu.command` — controlam o editor de layout. O comando padrão é `menu`.
- `year.mode` — `"school"` (derivado do nível), `"calendar"` (data do jogo através de `hmp-world`) ou `"both"`.
- `year.bands` — associa níveis a anos escolares; a última faixa correspondente é utilizada.
- `year.metadataKey` — metadados do personagem que podem substituir o ano derivado.
- `classes.items` — o horário das aulas repete-se **diariamente** no relógio do jogo. `start` / `end` utilizam `HH:MM`. `teacher` e `location` são apenas informações visuais.
- A adição de `x/y/z` e, opcionalmente, `areaId` ativa o marcador da aula no mapa.
- O marcador da aula utiliza `id` `class-focus` e o recurso `cah-hud`.

## Fluxo de dados

```text
hmp:spawn:complete ──▶ cah-hud (servidor) ──▶ cah-hud:show ──▶ cliente (webview apresentada + grupos do HUD nativo ocultados)

hmp:inventory:changed / hmp:progression:changed ──▶ partes alteradas ──▶ cah-hud:update

ciclo de 1 s (vida, dinheiro, relógio do mundo, aulas) ──▶ cah-hud:update (apenas diferenças)

consulta do cliente (1 s): Progression nativo + vida do LocalPlayer ──▶ Web.emit(view, "cah-hud:state")

/menu ──▶ cah-hud:menu ──▶ cliente (foco + controlo de entrada) ──▶ cah-hud:edit (modo de edição)

Guardar ──▶ callEvent("cah-hud:layout") ──▶ cah-hud:layout-save ──▶ core.metadata.setAccount ──▶ cah-hud:layout-saved
```

O cliente não envia dados de jogo; funciona apenas como camada de apresentação e confia no estado enviado pelo servidor.

## Exports

```js
const Hud = Imports.get("cah-hud");

await Hud.show(player);               // abre o HUD imediatamente (ignora a condição de spawn)
Hud.hide(player);                     // oculta-o até ao próximo spawn
await Hud.refresh(player);            // força o envio de uma atualização completa
await Hud.refresh(player, ["money"]); // atualiza apenas partes específicas
await Hud.setYearOverride(player, 4); // guarda { year: 4 } nos metadados do personagem (null remove)
await Hud.menu(player);               // abre o editor de layout /menu
await Hud.test(player);               // executa o teste de final de ano
Hud.status();                         // diagnósticos
```

## Comandos de chat

- `/menu` — abre o editor de layout do HUD.
- `/teste` — realiza o teste de final de ano.
- `/voz` — apresenta o estado e as definições do chat de voz.
- `/hud on` — apresenta o HUD antes do spawn.
- `/hud off` — oculta o HUD até ao próximo spawn.
- `/hud refresh` — força uma atualização completa.
- `/hud menu` — equivalente a `/menu`.

## Eventos do ciclo de vida enviados ao cliente

- `cah-hud:show` — estado completo, incluindo `layout`; apresenta a webview e oculta os grupos do HUD nativo.
- `cah-hud:update` — estado completo com diferenças calculadas no servidor.
- `cah-hud:hide` — oculta a webview e liberta os grupos do HUD nativo.
- `cah-hud:suspend` / `cah-hud:resume` — pedidos de outro ecrã em foco (ex.: mapa do réseau `hmp-flooflames`): esconde a webview **sem perder o estado** do servidor e repõe-na de imediato no resume; `show`/`update` recebidos entretanto ficam em buffer.
- `hmp-inventory:open` / `hmp-inventory:close` - o HUD se suspende enquanto a tela do inventario estiver aberta (a tecla e a pagina pertencem ao `hmp-inventory`).
- `cah-hud:gamehud` — política de ocultação do HUD nativo.
- `cah-hud:menu` — abre o editor de layout.
- `cah-hud:layout-saved` — confirmação de que o layout foi guardado.

A página do HUD recebe o estado final através do evento web `cah-hud:state`. A estrutura exata inclui `layout`, `playerId`, `test` e `spells`, além dos eventos `cah-hud:edit` / `cah-hud:saved`.

## Limitações conhecidas

- O horário de aulas não consegue utilizar dias da semana porque o estado do mundo do Framework apenas disponibiliza dia/mês/ano. As aulas repetem-se todos os dias do jogo.
- A apresentação da vida lê a vista de vitals (`hmp-pvp` export `vitals`, depois `Pvp.getVitals(id)` nativo) e só cai para `player.health`, que esta build pode nem expor. No cliente, a vida própria vem de `LocalPlayer.stateInfo`. Se nenhuma fonte responder, a barra permanece oculta.
- O marcador das aulas requer `hmp-blips`. Sem esse recurso, o horário continua a ser apresentado, mas o marcador é ignorado.
- A persistência do layout requer `hmp-core`. Sem ele, os layouts continuam a ser guardados no `localStorage` da máquina e podem ser partilhados através de Exportar/Importar, mas não acompanham a conta para outro computador.
- A ocultação do HUD nativo depende de `Hud.groups()` / `Hud.hideGroup()` do ambiente de execução, disponível desde o HogwartsMP 1.8. Em versões mais antigas, o HUD do jogo permanece inalterado.
