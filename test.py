"""要求:
1.定义一个 Student 类
2.构造方法接收 name 和 age 两个参数，并保存为实例属性
3.实现 show_info() 方法，输出格式为
姓名：小明，年龄：18
4.在 if __name__ == "__main__": 中创建 Student("小明", 18) 对象，并调用 show_info() 方法"""

class Student:
    def __init__(self, name, age):
        self.name = name
        self.age = age

    def show_info(self):
        print(f"姓名：{self.name}，年龄：{self.age}")

if __name__ == "__main__":
    student = Student("小明", 18)
    student.show_info()
