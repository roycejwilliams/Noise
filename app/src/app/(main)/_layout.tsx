import { SymbolView } from "expo-symbols";
import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const ACTIVE = "#ffffff";
const INACTIVE = "rgba(255,255,255,0.3)";

type IconName =
  | "house" | "house.fill"
  | "person" | "person.fill"
  | "person.2" | "person.2.fill"
  | "calendar";

function Icon({ name, focused }: { name: [IconName, IconName]; focused: boolean }) {
  return (
    <SymbolView
      name={focused ? name[1] : name[0]}
      size={22}
      tintColor={focused ? ACTIVE : INACTIVE}
      type="monochrome"
    />
  );
}

export default function MainLayout() {
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      initialRouteName="index"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ACTIVE,
        tabBarInactiveTintColor: INACTIVE,
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: "400",
        },
        tabBarStyle: {
          backgroundColor: "#1a1a1a",
          borderTopWidth: 0.5,
          borderTopColor: "rgba(255,255,255,0.15)",
          height: 60 + insets.bottom,
          elevation: 0,
          shadowOpacity: 0,
          shadowColor: "transparent",
          shadowRadius: 0,
          shadowOffset: { width: 0, height: 0 },
        },
        tabBarItemStyle: {
          paddingTop: 6,
          paddingBottom: 4,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ focused }) => (
            <Icon name={["house", "house.fill"]} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ focused }) => (
            <Icon name={["person", "person.fill"]} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="circle"
        options={{
          title: "Circle",
          tabBarIcon: ({ focused }) => (
            <Icon name={["person.2", "person.2.fill"]} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="moment"
        options={{
          title: "Moment",
          tabBarIcon: ({ focused }) => (
            <Icon name={["calendar", "calendar"]} focused={focused} />
          ),
        }}
      />
      {/* voice.tsx stays in this folder but is not a tab — pushed from root stack */}
      <Tabs.Screen
        name="voice"
        options={{ href: null }}
      />
    </Tabs>
  );
}
