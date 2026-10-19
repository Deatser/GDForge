// Lets the assistant use the game's windows the way a player does: list the
// buttons, checkboxes, text fields and sliders of whatever is on top, then
// click, type, slide, tap or drag. Everything goes through the game's own
// callbacks and touch handling, so a window behaves exactly as if it had been
// used by hand: trigger settings, Edit Object, Edit Group, HSV, the pause
// menu, and any window those open.
#include "Rpc.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <string_view>
#include <unordered_map>
#include <utility>

using namespace geode::prelude;

namespace gdforge::rpc {

    namespace {
        enum class Kind { Button, Toggle, Input, Slider, Control, Label };

        char const* kindName(Kind kind) {
            switch (kind) {
                case Kind::Button: return "button";
                case Kind::Toggle: return "toggle";
                case Kind::Input: return "input";
                case Kind::Slider: return "slider";
                case Kind::Control: return "control";
                case Kind::Label: return "label";
            }
            return "";
        }

        struct Control {
            CCNode* node;
            Kind kind;
            // It and every parent are visible
            bool shown;
        };

        // What a control shows, worked out only for the ones that are reported.
        struct Described {
            std::string text;
            std::string label;
            std::string name;
            CCRect rect;
        };

        std::string className(CCObject* object) {
            std::string name(geode::cocos::getObjectName(object));
            for (std::string_view prefix : { "class ", "struct " }) {
                if (name.starts_with(prefix)) name.erase(0, prefix.size());
            }
            return name;
        }

        std::string lower(std::string_view text) {
            std::string out(text);
            std::ranges::transform(out, out.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            return out;
        }

        // The scene's layers from the bottom one to the one drawn on top.
        std::vector<CCNode*> sceneLayers(CCScene* scene) {
            std::vector<CCNode*> layers;
            if (auto children = scene->getChildren()) {
                for (auto child : CCArrayExt<CCNode*>(children)) {
                    if (child->isVisible() && typeinfo_cast<CCLayer*>(child)) layers.push_back(child);
                }
            }
            std::ranges::stable_sort(layers, [](CCNode* a, CCNode* b) {
                if (a->getZOrder() != b->getZOrder()) return a->getZOrder() < b->getZOrder();
                return a->getOrderOfArrival() < b->getOrderOfArrival();
            });
            return layers;
        }

        // The layer a player would be using: the topmost popup or menu, or the
        // editor's interface when nothing covers it.
        geode::Result<CCNode*, RpcError> topLayer() {
            auto scene = CCDirector::get()->getRunningScene();
            if (!scene || typeinfo_cast<CCTransitionScene*>(scene)) {
                return fail("busy", "The game is switching screens. Try again in a moment.");
            }
            auto layers = sceneLayers(scene);
            if (layers.empty()) return fail("busy", "Nothing is on screen yet. Try again in a moment.");
            auto top = layers.back();
            if (auto editor = typeinfo_cast<LevelEditorLayer*>(top)) return Ok(static_cast<CCNode*>(editor->m_editorUI));
            return Ok(top);
        }

        // Every control under node, in a fixed order, so a control keeps its
        // number while the window only shows and hides parts of itself.
        void collect(CCNode* node, bool shown, std::vector<Control>& out) {
            shown = shown && node->isVisible();
            // A label is a sprite batch too, so it is told apart before batches are skipped
            if (auto label = typeinfo_cast<CCLabelBMFont*>(node)) {
                if (*label->getString()) out.push_back({ node, Kind::Label, shown });
                return;
            }
            // Level objects and their batches hold no controls, only a lot of nodes
            if (typeinfo_cast<GameObject*>(node) || typeinfo_cast<CCSpriteBatchNode*>(node)) return;
            if (typeinfo_cast<CCMenuItemToggler*>(node)) return out.push_back({ node, Kind::Toggle, shown });
            if (typeinfo_cast<Slider*>(node)) return out.push_back({ node, Kind::Slider, shown });
            if (typeinfo_cast<CCTextInputNode*>(node)) return out.push_back({ node, Kind::Input, shown });
            if (typeinfo_cast<CCMenuItem*>(node)) return out.push_back({ node, Kind::Button, shown });
            if (typeinfo_cast<cocos2d::extension::CCControl*>(node)) return out.push_back({ node, Kind::Control, shown });
            if (auto children = node->getChildren()) {
                for (auto child : CCArrayExt<CCNode*>(children)) collect(child, shown, out);
            }
        }

        std::vector<Control> controlsOf(CCNode* root) {
            std::vector<Control> controls;
            collect(root, true, controls);
            return controls;
        }

        // Where a node is on screen, in points from the bottom left corner.
        CCRect screenRect(CCNode* node) {
            if (auto slider = typeinfo_cast<Slider*>(node); slider && slider->m_groove) node = slider->m_groove;
            auto size = node->getContentSize();
            auto a = node->convertToWorldSpace(ccp(0.f, 0.f));
            auto b = node->convertToWorldSpace(ccp(size.width, size.height));
            return { std::min(a.x, b.x), std::min(a.y, b.y), std::abs(b.x - a.x), std::abs(b.y - a.y) };
        }

        float gap(CCRect const& a, CCRect const& b) {
            auto dx = std::max({ 0.f, a.getMinX() - b.getMaxX(), b.getMinX() - a.getMaxX() });
            auto dy = std::max({ 0.f, a.getMinY() - b.getMaxY(), b.getMinY() - a.getMaxY() });
            return std::hypot(dx, dy);
        }

        // Names of the sprite frames pictures show. The game only maps names
        // to frames, so the reverse map is built the first time it is needed.
        class FrameNames {
        public:
            std::string_view of(CCNode* node) {
                auto sprite = typeinfo_cast<CCSprite*>(node);
                if (!sprite) return {};
                if (!m_built) build();
                auto it = m_frames.find(sprite->getTexture());
                if (it == m_frames.end()) return {};
                auto rect = sprite->getTextureRect();
                for (auto const& [frameRect, name] : it->second) {
                    if (frameRect.equals(rect)) return name;
                }
                return {};
            }

            // The first named picture in a button's image, depth first.
            std::string_view within(CCNode* node) {
                if (typeinfo_cast<CCLabelBMFont*>(node)) return {};
                if (auto name = of(node); !name.empty()) return name;
                if (auto children = node->getChildren()) {
                    for (auto child : CCArrayExt<CCNode*>(children)) {
                        if (auto name = within(child); !name.empty()) return name;
                    }
                }
                return {};
            }

        private:
            void build() {
                m_built = true;
                auto frames = CCSpriteFrameCache::get()->m_pSpriteFrames;
                for (auto [name, frame] : CCDictionaryExt<std::string_view, CCSpriteFrame*>(frames)) {
                    m_frames[frame->getTexture()].emplace_back(frame->getRect(), std::string(name));
                }
            }

            bool m_built = false;
            std::unordered_map<CCTexture2D*, std::vector<std::pair<CCRect, std::string>>> m_frames;
        };

        // The words written on a node, e.g. "OK" on a button.
        void gatherText(CCNode* node, std::string& out) {
            if (typeinfo_cast<GameObject*>(node)) return;
            if (auto label = typeinfo_cast<CCLabelBMFont*>(node)) {
                std::string_view text = label->getString();
                if (!text.empty()) {
                    if (!out.empty()) out += ' ';
                    out += text;
                }
                return;
            }
            if (auto children = node->getChildren()) {
                for (auto child : CCArrayExt<CCNode*>(children)) gatherText(child, out);
            }
        }

        // The editor's own buttons by the names the assistant may use for them.
        std::unordered_map<CCNode*, char const*> editorButtons(CCNode* root) {
            auto ui = typeinfo_cast<EditorUI*>(root);
            if (!ui) return {};
            std::pair<CCNode*, char const*> const buttons[] = {
                { ui->m_editObjectBtn, "editObject" }, { ui->m_editGroupBtn, "editGroup" },
                { ui->m_editHSVBtn, "editHSV" }, { ui->m_editSpecialBtn, "editSpecial" },
                { ui->m_copyPasteBtn, "copyPaste" }, { ui->m_copyBtn, "copy" }, { ui->m_pasteBtn, "paste" },
                { ui->m_copyValuesBtn, "copyValues" }, { ui->m_pasteStateBtn, "pasteState" },
                { ui->m_pasteColorBtn, "pasteColor" }, { ui->m_goToLayerBtn, "goToLayer" },
                { ui->m_layerNextBtn, "layerNext" }, { ui->m_layerPrevBtn, "layerPrev" },
                { ui->m_goToBaseBtn, "goToBaseLayer" }, { ui->m_deselectBtn, "deselect" },
                { ui->m_linkBtn, "link" }, { ui->m_unlinkBtn, "unlink" }, { ui->m_enableLinkBtn, "linkControls" },
                { ui->m_undoBtn, "undo" }, { ui->m_redoBtn, "redo" }, { ui->m_trashBtn, "deleteSelected" },
                { ui->m_buildModeBtn, "buildMode" }, { ui->m_editModeBtn, "editMode" },
                { ui->m_deleteModeBtn, "deleteMode" }, { ui->m_swipeBtn, "swipe" },
                { ui->m_freeMoveBtn, "freeMove" }, { ui->m_snapBtn, "snap" }, { ui->m_rotateBtn, "rotate" },
                { ui->m_playbackBtn, "playMusic" }, { ui->m_playtestBtn, "playtest" },
                { ui->m_playtestStopBtn, "stopPlaytest" },
            };
            std::unordered_map<CCNode*, char const*> names;
            for (auto [node, name] : buttons) {
                if (node) names[node] = name;
            }
            return names;
        }

        bool isDisabled(CCNode* node) {
            if (auto item = typeinfo_cast<CCMenuItem*>(node)) {
                if (!item->isEnabled()) return true;
                if (auto menu = typeinfo_cast<CCMenu*>(item->getParent()); menu && !menu->isEnabled()) return true;
            }
            if (auto slider = typeinfo_cast<Slider*>(node)) return !slider->m_enabled;
            return false;
        }

        float sliderValue(Slider* slider) {
            return slider->m_touchLogic->m_thumb->getValue();
        }

        // Describes the controls of one window. Labels that stand on their own
        // name the control nearest to them, the way a player reads a window.
        class Window {
        public:
            explicit Window(CCNode* root) : m_controls(controlsOf(root)), m_names(editorButtons(root)) {
                for (auto const& control : m_controls) {
                    if (control.kind == Kind::Label && control.shown) m_labels.emplace_back(control.node, screenRect(control.node));
                }
            }

            std::vector<Control> const& controls() const { return m_controls; }

            Described describe(Control const& control) {
                Described out;
                auto node = control.node;
                out.rect = screenRect(node);
                if (auto it = m_names.find(node); it != m_names.end()) out.name = it->second;
                switch (control.kind) {
                    case Kind::Label:
                        out.text = static_cast<CCLabelBMFont*>(node)->getString();
                        return out;
                    case Kind::Input: {
                        auto input = static_cast<CCTextInputNode*>(node);
                        out.text = input->getString();
                        break;
                    }
                    case Kind::Toggle: {
                        auto toggle = static_cast<CCMenuItemToggler*>(node);
                        if (auto active = toggle->isToggled() ? toggle->m_onButton : toggle->m_offButton) gatherText(active, out.text);
                        break;
                    }
                    case Kind::Button:
                        if (auto create = typeinfo_cast<CreateMenuItem*>(node)) {
                            out.text = fmt::format("object {}", create->m_objectID);
                            return out;
                        }
                        gatherText(node, out.text);
                        if (out.text.empty()) {
                            auto image = typeinfo_cast<CCMenuItemSprite*>(node);
                            out.text = m_frames.within(image && image->getNormalImage() ? image->getNormalImage() : node);
                        }
                        break;
                    case Kind::Control:
                        out.text = className(node);
                        break;
                    case Kind::Slider:
                        break;
                }
                // A button with words on it needs no label
                if (control.kind != Kind::Button || out.text.find(".png") != std::string::npos || out.text.empty()) {
                    out.label = nearestLabel(out.rect);
                }
                return out;
            }

            matjson::Value toJson(size_t id, Control const& control) {
                auto info = describe(control);
                auto object = matjson::makeObject({
                    { "id", static_cast<int>(id) },
                    { "kind", std::string(kindName(control.kind)) },
                    { "x", static_cast<int>(std::lround(info.rect.getMidX())) },
                    { "y", static_cast<int>(std::lround(info.rect.getMidY())) },
                });
                if (!info.text.empty()) object["text"] = info.text;
                if (!info.label.empty()) object["label"] = info.label;
                if (!info.name.empty()) object["name"] = info.name;
                if (control.kind == Kind::Toggle) object["on"] = static_cast<CCMenuItemToggler*>(control.node)->isToggled();
                if (control.kind == Kind::Slider) {
                    object["value"] = std::round(sliderValue(static_cast<Slider*>(control.node)) * 1000.0) / 1000.0;
                }
                if (control.kind != Kind::Label) {
                    object["w"] = static_cast<int>(std::lround(info.rect.size.width));
                    object["h"] = static_cast<int>(std::lround(info.rect.size.height));
                }
                if (auto tag = control.node->getTag(); tag > 0) object["tag"] = tag;
                if (auto nodeID = std::string_view(control.node->getID()); !nodeID.empty()) object["nodeId"] = std::string(nodeID);
                if (!control.shown) object["hidden"] = true;
                if (isDisabled(control.node)) object["disabled"] = true;
                return object;
            }

            // A control picked by its number from ui.inspect, or by what it says:
            // an editor button's name, a node ID, the words on it or its label.
            // Only controls of the given kinds and on screen are considered.
            geode::Result<size_t, RpcError> find(matjson::Value const& target, std::initializer_list<Kind> kinds) {
                auto fits = [&](Control const& control) { return std::ranges::find(kinds, control.kind) != kinds.end(); };
                if (auto id = optInt(target)) {
                    if (*id < 0 || static_cast<size_t>(*id) >= m_controls.size()) {
                        return fail("not_found", fmt::format("There is no control #{} in this window. Call gd_ui without actions to list them.", *id));
                    }
                    auto const& control = m_controls[*id];
                    if (!fits(control)) {
                        return fail("wrong_kind", fmt::format("#{} is a {}, which this action does not work on.", *id, kindName(control.kind)));
                    }
                    if (!control.shown) {
                        return fail("hidden", fmt::format("#{} is not on screen. It may be on another page of the window.", *id));
                    }
                    return Ok(static_cast<size_t>(*id));
                }
                if (!target.isString()) return fail("bad_request", "Name the control by its number or by what it says.");
                auto wanted = lower(target.asString().unwrap());
                for (size_t id = 0; id < m_controls.size(); ++id) {
                    auto const& control = m_controls[id];
                    if (!control.shown || !fits(control)) continue;
                    auto info = describe(control);
                    auto nodeID = std::string_view(control.node->getID());
                    if (lower(info.name) == wanted || lower(nodeID) == wanted || lower(info.text) == wanted || lower(info.label) == wanted) {
                        return Ok(id);
                    }
                }
                return fail("not_found", fmt::format(
                    "Nothing on screen says \"{}\". Call gd_ui without actions to see the window.", target.asString().unwrap()
                ));
            }

        private:
            std::string nearestLabel(CCRect const& rect) {
                // Further than this a label belongs to something else, e.g. the window title
                constexpr float REACH = 50.f;
                CCNode* best = nullptr;
                float bestGap = REACH;
                for (auto const& [label, labelRect] : m_labels) {
                    auto distance = gap(rect, labelRect);
                    if (distance < bestGap) {
                        best = label;
                        bestGap = distance;
                    }
                }
                return best ? static_cast<CCLabelBMFont*>(best)->getString() : "";
            }

            std::vector<Control> m_controls;
            std::unordered_map<CCNode*, char const*> m_names;
            std::vector<std::pair<CCNode*, CCRect>> m_labels;
            FrameNames m_frames;
        };

        // A popup grows in for a moment after it opens. Positions read meanwhile
        // are off, so callers wait until it has settled.
        bool settling(CCNode* root) {
            auto alert = typeinfo_cast<FLAlertLayer*>(root);
            return alert && alert->m_mainLayer && alert->m_mainLayer->numberOfRunningActions() > 0;
        }

        RpcResult inspect(matjson::Value const& params) {
            GEODE_UNWRAP_INTO(auto root, topLayer());
            auto all = flag(params["all"], false);
            auto filter = lower(params["filter"].asString().unwrapOr(""));
            auto limit = static_cast<size_t>(std::max(1, optInt(params["limit"]).value_or(400)));

            Window window(root);
            auto list = matjson::Value::array();
            size_t matched = 0;
            auto const& controls = window.controls();
            for (size_t id = 0; id < controls.size(); ++id) {
                if (!all && !controls[id].shown) continue;
                auto entry = window.toJson(id, controls[id]);
                if (!filter.empty()) {
                    std::string haystack;
                    auto const& fields = entry;
                    for (auto key : { "text", "label", "name", "nodeId" }) {
                        if (fields[key].isString()) haystack += lower(fields[key].asString().unwrap()) + '\n';
                    }
                    if (haystack.find(filter) == std::string::npos) continue;
                }
                if (++matched <= limit) list.push(std::move(entry));
            }

            auto layers = matjson::Value::array();
            for (auto layer : sceneLayers(CCDirector::get()->getRunningScene())) layers.push(className(layer));
            auto winSize = CCDirector::get()->getWinSize();
            auto result = matjson::makeObject({
                { "layer", className(root) },
                { "layers", std::move(layers) },
                { "screen", matjson::makeObject({
                    { "width", static_cast<int>(std::lround(winSize.width)) },
                    { "height", static_cast<int>(std::lround(winSize.height)) },
                }) },
                { "controls", std::move(list) },
            });
            if (matched > limit) result["truncated"] = static_cast<int>(matched);
            if (settling(root)) result["settling"] = true;
            return Ok(result);
        }

        // Touches carry window coordinates with y going down; the director
        // turns them into points with y going up. This is the way back.
        CCPoint toView(CCPoint point) {
            auto director = CCDirector::get();
            auto origin = director->convertToGL(ccp(0.f, 0.f));
            auto unit = director->convertToGL(ccp(1.f, 1.f)) - origin;
            return ccp((point.x - origin.x) / unit.x, (point.y - origin.y) / unit.y);
        }

        // Presses the screen at a point and lets go, optionally after dragging
        // to another, through the dispatcher real touches go through, so
        // whatever is on top at that point gets it.
        void touch(CCPoint from, std::optional<CCPoint> to) {
            // Enough intermediate points for sliders and pickers to follow the finger
            constexpr int DRAG_STEPS = 12;
            auto dispatcher = CCDirector::get()->getTouchDispatcher();
            auto finger = new CCTouch();
            finger->autorelease();
            auto touches = CCSet::create();
            touches->addObject(finger);
            auto moveTo = [&](CCPoint point) {
                auto view = toView(point);
                finger->setTouchInfo(0, view.x, view.y);
            };
            moveTo(from);
            dispatcher->touchesBegan(touches, nullptr);
            if (to) {
                for (int step = 1; step <= DRAG_STEPS; ++step) {
                    auto t = static_cast<float>(step) / DRAG_STEPS;
                    moveTo(ccp(from.x + (to->x - from.x) * t, from.y + (to->y - from.y) * t));
                    dispatcher->touchesMoved(touches, nullptr);
                }
            }
            dispatcher->touchesEnded(touches, nullptr);
        }

        // Clicks a button or checkbox the way CCMenu does when it is released over one.
        void press(CCMenuItem* item) {
            // The callback may close the window the item is in
            Ref<CCMenuItem> keep(item);
            item->selected();
            item->unselected();
            item->activate();
        }

        geode::Result<CCPoint, RpcError> point(matjson::Value const& x, matjson::Value const& y) {
            auto px = optNumber(x);
            auto py = optNumber(y);
            if (!px || !py) return fail("bad_request", "Give the point as x and y in screen points.");
            return Ok(ccp(static_cast<float>(*px), static_cast<float>(*py)));
        }

        RpcResult act(matjson::Value const& params) {
            GEODE_UNWRAP_INTO(auto root, topLayer());
            auto action = params["action"].asString().unwrapOr("");
            auto result = matjson::makeObject({ { "action", action } });

            if (action == "tap" || action == "drag") {
                GEODE_UNWRAP_INTO(auto from, point(params["x"], params["y"]));
                std::optional<CCPoint> to;
                if (action == "drag") {
                    GEODE_UNWRAP_INTO(auto end, point(params["toX"], params["toY"]));
                    to = end;
                }
                touch(from, to);
            }
            else if (action == "key") {
                // A key as the keyboard sends it: pressed and let go, or only one of the two to hold it
                auto code = optInt(params["code"]);
                if (!code) return fail("bad_request", "Give the key.");
                auto phase = params["phase"].asString().unwrapOr("press");
                auto keyboard = CCKeyboardDispatcher::get();
                auto key = static_cast<enumKeyCodes>(*code);
                keyboard->updateModifierKeys(flag(params["shift"], false), flag(params["ctrl"], false), flag(params["alt"], false), false);
                if (phase != "up") keyboard->dispatchKeyboardMSG(key, true, false, 0.0);
                if (phase != "down") {
                    keyboard->dispatchKeyboardMSG(key, false, false, 0.0);
                    keyboard->updateModifierKeys(false, false, false, false);
                }
            }
            else if (action == "back") {
                // What Escape does: closes a popup, or opens the pause menu over the editor
                if (auto layer = typeinfo_cast<CCLayer*>(root)) layer->keyBackClicked();
            }
            else {
                Window window(root);
                auto const& controls = window.controls();
                auto target = params["target"];
                auto disabled = [&](size_t id) -> geode::Result<void, RpcError> {
                    if (isDisabled(controls[id].node)) return fail("disabled", fmt::format("#{} is greyed out and cannot be used right now.", id));
                    return Ok();
                };

                if (action == "click" || action == "check") {
                    GEODE_UNWRAP_INTO(auto id, window.find(target, { Kind::Button, Kind::Toggle }));
                    GEODE_UNWRAP(disabled(id));
                    auto item = static_cast<CCMenuItem*>(controls[id].node);
                    result["id"] = static_cast<int>(id);
                    auto toggle = typeinfo_cast<CCMenuItemToggler*>(item);
                    if (action == "check") {
                        if (!toggle) return fail("wrong_kind", fmt::format("#{} is a button, not a checkbox.", id));
                        if (!params["on"].isBool()) return fail("bad_request", "Say whether the checkbox should end up on or off.");
                        auto wanted = params["on"].asBool().unwrap();
                        result["changed"] = toggle->isToggled() != wanted;
                        if (toggle->isToggled() != wanted) press(item);
                    }
                    else press(item);
                }
                else if (action == "type") {
                    GEODE_UNWRAP_INTO(auto id, window.find(target, { Kind::Input }));
                    if (!params["text"].isString()) return fail("bad_request", "Give the text to type.");
                    auto input = static_cast<CCTextInputNode*>(controls[id].node);
                    Ref<CCTextInputNode> keep(input);
                    input->setString(params["text"].asString().unwrap());
                    // What the window hears while a player types into the field and then leaves it
                    if (auto delegate = input->m_delegate) {
                        delegate->textChanged(input);
                        delegate->textInputClosed(input);
                    }
                    result["id"] = static_cast<int>(id);
                    result["text"] = std::string(input->getString());
                }
                else if (action == "slide") {
                    GEODE_UNWRAP_INTO(auto id, window.find(target, { Kind::Slider }));
                    GEODE_UNWRAP(disabled(id));
                    auto value = optNumber(params["value"]);
                    if (!value) return fail("bad_request", "Give the slider position from 0 (left) to 1 (right).");
                    auto slider = static_cast<Slider*>(controls[id].node);
                    Ref<Slider> keep(slider);
                    // A drag: the window hears the start, the moved thumb, and the end
                    if (slider->m_delegate) slider->m_delegate->sliderBegan(slider);
                    slider->setValue(std::clamp(static_cast<float>(*value), 0.f, 1.f));
                    slider->m_touchLogic->m_thumb->activate();
                    if (slider->m_delegate) slider->m_delegate->sliderEnded(slider);
                    result["id"] = static_cast<int>(id);
                    result["value"] = static_cast<double>(sliderValue(slider));
                }
                else {
                    return fail("bad_request", "Unknown action. Use click, check, type, slide, tap, drag, key or back.");
                }
            }

            if (auto top = topLayer()) result["layer"] = className(top.unwrap());
            return Ok(result);
        }
    }

    void registerUi(RpcRegistry& registry) {
        registry["ui.inspect"] = inspect;
        registry["ui.act"] = act;
    }

}
